import axios from 'axios';

// Public links must not attach the professional token or expire its session on a 401.
// Authorization and link validity remain enforced by the server.
export default axios.create({ baseURL: '/api', timeout: 15000 });
