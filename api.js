'use strict';

module.exports = {
  async getDashboard({ homey }) {
    return homey.app.getDashboardSnapshot();
  },

  async updateRoute({ homey, params, body }) {
    return homey.app.updateRoute(params.id, body || {});
  },

  async refreshEverything({ homey }) {
    return homey.app.refreshEverything();
  },

  async getNearby({ homey, query }) {
    const limit = Math.min(Math.max(Number(query && query.limit) || 12, 1), 25);
    return homey.app.getNearbyBridges(limit);
  },

};
