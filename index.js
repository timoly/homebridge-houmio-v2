const R = require('ramda')
const io = require('socket.io-client')
const socket = io('https://houmi.herokuapp.com')
const rp = require('request-promise');
const siteKey = process.env.SITEKEY

var Service, Characteristic;
module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerPlatform("homebridge-houmio", "Houmio", HoumioPlatform)
}

function HoumioPlatform(log) {
  this.log = log;
  this.log("houmio Platform Plugin");
}

function HoumioAccessory(log, device, api) {
  this.id = device._id
  this.name = device.room ? `${device.name} ${device.room}` : device.name
  this.model = device.protocol
  this.device = device
  this.api = api
  this.log = log
  this.manufacturer = device.manufacturer
}

function fetchHoumioLights(){
  return rp({
    uri: `https://houmi.herokuapp.com/api/site/${siteKey}`,
    json: true
  })
  .then(({lights}) => lights)
}

HoumioPlatform.prototype = {
  accessories: function(callback) {
    this.log("Fetching houmio lights...");
    var that = this;

    socket.on("connect", function() {
      socket.emit('clientReady', { siteKey })
    })
    fetchHoumioLights()
      .then(lights => {
        const foundAccessories = lights.map(l => {
          return new HoumioAccessory(that.log, l, {})
        })

        callback(foundAccessories);
    })
  }
}

HoumioAccessory.prototype = {
  // Convert 0-255 to 0-100
  bitsToPercentage: function(value) {
    return Math.round(value / 255 * 100)
  },
  percentageToBits: function(value){
    return Math.round(value / 100 * 255)
  },
  extractValue: function(characteristic, status) {
    switch(characteristic.toLowerCase()) {
      case 'power':
        return status.on ? 1 : 0;
      case 'brightness':
        return this.bitsToPercentage(status.bri);
      default:
        return null;
    }
  },

  executeChange: function(cmd, value, callback) {
    const supportedCommands = ['power', 'brightness']

    if(R.any(R.equals, supportedCommands)){
      fetchHoumioLights()
      .then(lights => lights.filter(({_id}) => _id === this.id))
      .then(({on}) => {
        if(!on && cmd === 'power' && (value === 1 || value === true)){
          return {bri: 255}
        }
        else if(cmd === 'brightness'){
          return {bri: this.percentageToBits(value)}
        }
        return {}
      })
      .then(brightness => {
        const on = {on: cmd === 'power' && (value === 0 || value === false) ? false : true}
        socket.emit('apply/light', R.mergeAll([{_id: this.id}, on, brightness]))
        callback()
      })
    }
  },

  getState: function(characteristic, callback) {
    fetchHoumioLights()
      .then(lights => lights.find(({_id}) => _id === this.id))
      .then(light => this.extractValue(characteristic, light))
      .then(value => callback(null, value))
  },

  identify: function(callback) {
    this.executeChange("identify", true, callback)
  },

  getServices: function() {
    var that = this;

    // Use HomeKit types defined in HAP node JS
    var lightbulbService = new Service.Lightbulb(this.name)

    lightbulbService
    .getCharacteristic(Characteristic.On)
    .on('get', function(callback) { that.getState("power", callback)})
    .on('set', function(value, callback) { that.executeChange("power", value, callback)})
    .value = this.extractValue("power", this.device)

    lightbulbService
    .addCharacteristic(Characteristic.Brightness)
    .on('get', function(callback) { that.getState("brightness", callback);})
    .on('set', function(value, callback) { that.executeChange("brightness", value, callback)})
    .value = this.extractValue("brightness", this.device)

    var informationService = new Service.AccessoryInformation()

    informationService
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.device.uniqueid)
      .addCharacteristic(Characteristic.FirmwareRevision, this.device.swversion);

    return [informationService, lightbulbService];
  }
};
