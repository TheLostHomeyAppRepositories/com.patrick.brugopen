'use strict';
const Homey = require('homey');
const { BridgeFeedService } = require('./lib/bridge_feed_service');
const { version: APP_VERSION } = require('./package.json');

class BrugOpenApp extends Homey.App {
  async onInit() {
    this.log(`Brug Open app started (v${APP_VERSION})`);
    this._registerTriggerCards(); this._registerConditionCards(); this._registerActionCards();
    this.bridgeFeed = new BridgeFeedService(this.homey); this.bridgeFeed.start();
  }
  async onUninit() { if (this.bridgeFeed) this.bridgeFeed.stop(); }
  _requireDevice(args) { if (!args || !args.device) throw new Error(this.homey.__('errors.no_device')); return args.device; }
  _registerTriggerCards() {
    this._triggerCards = {};
    for (const id of ['bridge_opened','bridge_closed','bridge_planned','bridge_status_changed']) {
      const card = this.homey.flow.getDeviceTriggerCard(id); card.registerRunListener(async () => true); this._triggerCards[id] = card;
    }
  }
  _registerConditionCards() {
    const status = args => String(this._requireDevice(args).getCapabilityValue('bridge_status') || 'unknown');
    this.homey.flow.getConditionCard('bridge_is_open').registerRunListener(async args => status(args) === 'open');
    this.homey.flow.getConditionCard('bridge_is_closed').registerRunListener(async args => status(args) === 'closed');
    this.homey.flow.getConditionCard('bridge_is_planned').registerRunListener(async args => status(args) === 'planned');
    this.homey.flow.getConditionCard('bridge_status_is').registerRunListener(async args => status(args) === String(args.status || 'unknown'));
  }
  _registerActionCards() {
    this.homey.flow.getActionCard('refresh_bridge_status').registerRunListener(async args => {
      this._requireDevice(args); return this.refreshBridgeData();
    });
  }
  registerBridgeDevice(device) { if (this.bridgeFeed) this.bridgeFeed.register(device); }
  unregisterBridgeDevice(device) { if (this.bridgeFeed) this.bridgeFeed.unregister(device); }
  async refreshBridgeData() { if (!this.bridgeFeed) throw new Error(this.homey.__('errors.refresh_failed')); return this.bridgeFeed.refresh(); }
  async triggerBridge(id, device, tokens = {}, state = {}) {
    const card = this._triggerCards && this._triggerCards[id]; if (!card) return false;
    return card.trigger(device, tokens, state);
  }
}
module.exports = BrugOpenApp;
