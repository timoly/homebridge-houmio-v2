const R = require('ramda')
const io = require('socket.io-client')
const socket = io('https://houmi.herokuapp.com')
const rp = require('request-promise')

var Service, Characteristic

module.exports = function(homebridge) {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  homebridge.registerPlatform("homebridge-houmio", "Houmio", HoumioPlatform)
}

var cachedLights, statusUpdate = 0
function fetchHoumioLights(siteKey){
  if((Date.now() - statusUpdate) > 3000){
    statusUpdate = Date.now()
    return rp({
      uri: `https://houmi.herokuapp.com/api/site/${siteKey}`,
      json: true
    })
    .then(({lights}) => {
      cachedLights = lights
      return lights
    })
  }
  return new Promise(res => res(cachedLights))
}

function HoumioPlatform(log, config) {
  this.log = log
  const {siteKey} = config

  this.siteKey = siteKey
  this.fetchHoumioLights = fetchHoumioLights.bind(null, siteKey)
  this.log(`houmio Platform Plugin, sitekey: ${siteKey}`)
}

function HoumioAccessory(log, device, siteKey) {
  this.id = device._id
  this.name = device.room ? `${device.name} ${device.room}` : device.name
  this.model = device.protocol
  this.device = device
  this.log = log
  this.manufacturer = device.manufacturer
  this.fetchHoumioLights = fetchHoumioLights.bind(null, siteKey)
}

HoumioPlatform.prototype = {
  accessories: function(callback) {
    this.log("Fetching houmio lights...")

    socket.on("connect", _ => {
      socket.emit('clientReady', { siteKey: this.siteKey })
    })

    this.fetchHoumioLights()
      .then(lights => {
        const foundAccessories = lights.map(l => new HoumioAccessory(this.log, l, this.siteKey))
        callback(foundAccessories)
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
        return status.on ? 1 : 0
      case 'brightness':
        return this.bitsToPercentage(status.bri)
      default:
        return null
    }
  },

  executeChange: function(cmd, value, callback) {
    const supportedCommands = ['power', 'brightness']

    if(R.any(R.equals, supportedCommands)){
      this.fetchHoumioLights()
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

  getState: function(characteristic, callback){
    this.fetchHoumioLights()
      .then(lights => lights.find(({_id}) => _id === this.id))
      .then(light => this.extractValue(characteristic, light))
      .then(value => callback(null, value))
  },

  identify: function(callback) {
    this.executeChange("identify", true, callback)
  },

  getServices: function() {
    // Use HomeKit types defined in HAP node JS
    var lightbulbService = new Service.Lightbulb(this.name)

    const getState = this.getState.bind(this)
    const executeChange = this.executeChange.bind(this)

    lightbulbService
      .getCharacteristic(Characteristic.On)
      .on('get', callback => { getState("power", callback)})
      .on('set', (value, callback) => { executeChange("power", value, callback)})
      .value = this.extractValue("power", this.device)

    lightbulbService
      .addCharacteristic(Characteristic.Brightness)
      .on('get', callback => { getState("brightness", callback)})
      .on('set', (value, callback) => { executeChange("brightness", value, callback)})
      .value = this.extractValue("brightness", this.device)

    var informationService = new Service.AccessoryInformation()

    informationService
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.device.uniqueid)
      .addCharacteristic(Characteristic.FirmwareRevision, this.device.swversion)

    return [informationService, lightbulbService]
  }
}
