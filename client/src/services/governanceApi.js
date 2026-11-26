import api from './api';

const governanceApi = {
  async listReleases() {
    return (await api.get('/governance/admin/releases')).data;
  },
  async createRelease(payload) {
    return (await api.post('/governance/admin/releases', payload)).data;
  },
  async updateRelease(id, payload) {
    return (await api.patch(`/governance/admin/releases/${id}`, payload)).data;
  },
  async listFeatureFlags() {
    return (await api.get('/governance/admin/feature-flags')).data;
  },
  async createFeatureFlag(payload) {
    return (await api.post('/governance/admin/feature-flags', payload)).data;
  },
  async updateFeatureFlag(id, payload) {
    return (await api.patch(`/governance/admin/feature-flags/${id}`, payload)).data;
  },
  async toggleKillSwitch(id, payload) {
    return (await api.post(`/governance/admin/feature-flags/${id}/kill-switch`, payload)).data;
  },
  async getFeatureFlagRules(id) {
    return (await api.get(`/governance/admin/feature-flags/${id}/rules`)).data;
  },
  async setPilotGroupRule(flagId, groupId, payload) {
    return (await api.put(
      `/governance/admin/feature-flags/${flagId}/pilot-groups/${groupId}`,
      payload
    )).data;
  },
  async removePilotGroupRule(flagId, groupId, reason) {
    return (await api.delete(
      `/governance/admin/feature-flags/${flagId}/pilot-groups/${groupId}`,
      { data: { reason } }
    )).data;
  },
  async listPilotGroups() {
    return (await api.get('/governance/admin/pilot-groups')).data;
  },
  async createPilotGroup(payload) {
    return (await api.post('/governance/admin/pilot-groups', payload)).data;
  },
  async updatePilotGroup(id, payload) {
    return (await api.patch(`/governance/admin/pilot-groups/${id}`, payload)).data;
  },
  async listPilotGroupMembers(id) {
    return (await api.get(`/governance/admin/pilot-groups/${id}/members`)).data;
  },
  async addPilotGroupMember(id, payload) {
    return (await api.post(`/governance/admin/pilot-groups/${id}/members`, payload)).data;
  },
  async removePilotGroupMember(groupId, userId, reason) {
    return (await api.delete(
      `/governance/admin/pilot-groups/${groupId}/members/${userId}`,
      { data: { reason } }
    )).data;
  },
  async listAudit(limit = 100) {
    return (await api.get(`/governance/admin/audit?limit=${limit}`)).data;
  },
  async listUsers() {
    return (await api.get('/users')).data;
  },
};

export default governanceApi;
