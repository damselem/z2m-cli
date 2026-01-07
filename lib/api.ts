/**
 * Zigbee2MQTT WebSocket API client for Bun
 */

export interface Z2MConfig {
  url?: string;
  timeout?: number;
}

export interface Z2MDevice {
  ieee_address: string;
  friendly_name: string;
  type: 'Coordinator' | 'Router' | 'EndDevice';
  network_address: number;
  power_source?: string;
  model_id?: string;
  manufacturer?: string;
  interview_completed: boolean;
  disabled: boolean;
  definition?: {
    model: string;
    vendor: string;
    description: string;
    exposes?: unknown[];
  };
  endpoints?: Record<string, unknown>;
  date_code?: string;
  software_build_id?: string;
}

export interface Z2MGroup {
  id: number;
  friendly_name: string;
  members: Array<{
    ieee_address: string;
    endpoint: number;
  }>;
}

export interface Z2MBridgeInfo {
  version: string;
  commit: string;
  coordinator: {
    ieee_address: string;
    type: string;
    meta: Record<string, unknown>;
  };
  network: {
    channel: number;
    pan_id: number;
    extended_pan_id: string;
  };
  log_level: string;
  permit_join: boolean;
  permit_join_timeout?: number;
  config: Record<string, unknown>;
  config_schema: Record<string, unknown>;
  restart_required: boolean;
}

export interface Z2MDeviceState {
  [key: string]: unknown;
  battery?: number;
  linkquality?: number;
  temperature?: number;
  humidity?: number;
  state?: string;
  brightness?: number;
  last_seen?: string;
}

export interface DiagnosticIssue {
  device: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  value?: unknown;
}

export interface DiagnosticReport {
  summary: {
    totalDevices: number;
    routers: number;
    endDevices: number;
    coordinator: number;
    disabled: number;
    criticalIssues: number;
    warnings: number;
  };
  issues: DiagnosticIssue[];
  devices: Array<{
    name: string;
    ieee: string;
    type: string;
    lqi?: number;
    battery?: number;
    lastSeen?: string;
    model?: string;
  }>;
}

/**
 * Zigbee2MQTT WebSocket API client class
 */
export class Z2MClient {
  private wsUrl: string;
  private timeout: number;

  constructor(options: Z2MConfig = {}) {
    const baseUrl = (options.url || Bun.env.Z2M_URL || 'ws://localhost:8080').replace(/\/$/, '');
    // Ensure we have the /api endpoint
    this.wsUrl = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
    // Convert http(s) to ws(s) if needed
    this.wsUrl = this.wsUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    this.timeout = options.timeout || 10000;
  }

  /**
   * Execute a WebSocket request and wait for response
   */
  private async request<T>(
    requestTopic?: string,
    payload?: unknown,
    responseTopic?: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`Request timed out after ${this.timeout}ms`));
        }
      }, this.timeout);

      ws.onopen = () => {
        if (requestTopic) {
          ws.send(JSON.stringify({ topic: requestTopic, payload: payload || {} }));
        }
      };

      ws.onerror = (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error(`WebSocket error: ${error}`));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          // If we're looking for a specific response topic
          if (responseTopic && data.topic === responseTopic) {
            resolved = true;
            clearTimeout(timeoutId);
            ws.close();
            resolve(data.payload as T);
          }
          // If no specific topic, return any bridge response
          else if (!responseTopic && requestTopic && data.topic?.startsWith('bridge/')) {
            resolved = true;
            clearTimeout(timeoutId);
            ws.close();
            resolve(data.payload as T);
          }
        } catch {
          // Ignore parse errors, wait for valid message
        }
      };

      ws.onclose = () => {
        clearTimeout(timeoutId);
        if (!resolved) {
          reject(new Error('WebSocket closed before receiving response'));
        }
      };
    });
  }

  /**
   * Collect messages from WebSocket for a duration
   */
  private async collect<T>(
    filter: (topic: string, payload: unknown) => boolean,
    duration: number = 3000,
    requestTopic?: string,
    requestPayload?: unknown
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const results: T[] = [];

      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(results);
      }, duration);

      ws.onopen = () => {
        if (requestTopic) {
          ws.send(JSON.stringify({ topic: requestTopic, payload: requestPayload || {} }));
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`WebSocket error: ${error}`));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (filter(data.topic, data.payload)) {
            results.push(data.payload as T);
          }
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  // ============ Device Operations ============

  async getDevices(): Promise<Z2MDevice[]> {
    return this.request('bridge/request/devices', {}, 'bridge/devices');
  }

  async getDevicesRaw(): Promise<Array<Z2MDevice & { description?: string }>> {
    return this.request('bridge/request/devices', {}, 'bridge/devices');
  }

  async getDevice(nameOrIeee: string): Promise<Z2MDevice | null> {
    const devices = await this.getDevices();
    return devices.find(
      d => d.friendly_name === nameOrIeee || d.ieee_address === nameOrIeee
    ) || null;
  }

  async getDeviceState(name: string): Promise<Z2MDeviceState | null> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      let state: Z2MDeviceState | null = null;

      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(state);
      }, 5000);

      ws.onerror = () => {
        clearTimeout(timeoutId);
        resolve(null);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.topic === name) {
            state = data.payload;
            clearTimeout(timeoutId);
            ws.close();
            resolve(state);
          }
        } catch {
          // Ignore
        }
      };
    });
  }

  async setDeviceState(name: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(); // Assume success if no error
      }, 3000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ topic: `${name}/set`, payload }));
        // Give it a moment then close
        setTimeout(() => {
          clearTimeout(timeoutId);
          ws.close();
          resolve();
        }, 1000);
      };

      ws.onerror = (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to set device state: ${error}`));
      };
    });
  }

  async setGroupState(nameOrId: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(); // Assume success if no error
      }, 3000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ topic: `${nameOrId}/set`, payload }));
        setTimeout(() => {
          clearTimeout(timeoutId);
          ws.close();
          resolve();
        }, 1000);
      };

      ws.onerror = (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to set group state: ${error}`));
      };
    });
  }

  async renameDevice(oldName: string, newName: string): Promise<void> {
    await this.request(
      'bridge/request/device/rename',
      { from: oldName, to: newName },
      'bridge/response/device/rename'
    );
  }

  async removeDevice(name: string, force: boolean = false): Promise<void> {
    await this.request(
      'bridge/request/device/remove',
      { id: name, force },
      'bridge/response/device/remove'
    );
  }

  async setDeviceOptions(name: string, options: Record<string, unknown>): Promise<void> {
    await this.request(
      'bridge/request/device/options',
      { id: name, options },
      'bridge/response/device/options'
    );
  }

  // ============ Group Operations ============

  async getGroups(): Promise<Z2MGroup[]> {
    return this.request('bridge/request/groups', {}, 'bridge/groups');
  }

  async getGroup(nameOrId: string | number): Promise<Z2MGroup | null> {
    const groups = await this.getGroups();
    return groups.find(
      g => g.friendly_name === nameOrId || g.id === Number(nameOrId)
    ) || null;
  }

  // ============ Bridge Operations ============

  async getBridgeInfo(): Promise<Z2MBridgeInfo> {
    return this.request('bridge/request/info', {}, 'bridge/info');
  }

  async getBridgeState(): Promise<{ state: string }> {
    return this.request('bridge/request/state', {}, 'bridge/state');
  }

  async restartBridge(): Promise<void> {
    await this.request('bridge/request/restart', {}, 'bridge/response/restart');
  }

  async permitJoin(permit: boolean, time?: number, device?: string): Promise<void> {
    const payload: Record<string, unknown> = { value: permit };
    if (time !== undefined) payload.time = time;
    if (device) payload.device = device;
    await this.request('bridge/request/permit_join', payload, 'bridge/response/permit_join');
  }

  async setLogLevel(level: 'debug' | 'info' | 'warning' | 'error'): Promise<void> {
    await this.request(
      'bridge/request/options',
      { options: { advanced: { log_level: level } } },
      'bridge/response/options'
    );
  }

  // ============ Network Operations ============

  async getNetworkMap(timeout?: number): Promise<unknown> {
    // Network map can take a long time, especially on large networks
    const savedTimeout = this.timeout;
    if (timeout) {
      this.timeout = timeout;
    }
    try {
      return await this.request(
        'bridge/request/networkmap',
        { type: 'raw', routes: true },
        'bridge/response/networkmap'
      );
    } finally {
      this.timeout = savedTimeout;
    }
  }

  // ============ Diagnostic Operations ============

  async diagnose(): Promise<DiagnosticReport> {
    const LQI_CRITICAL = 30;
    const LQI_LOW = 50;
    const BATTERY_CRITICAL = 15;
    const BATTERY_LOW = 25;
    const STALE_HOURS = 24;

    // Get devices and their states
    const devices = await this.getDevices();
    const states = await this.collectDeviceStates(5000);

    const issues: DiagnosticIssue[] = [];
    const deviceSummaries: DiagnosticReport['devices'] = [];

    let routers = 0;
    let endDevices = 0;
    let coordinator = 0;
    let disabled = 0;

    for (const device of devices) {
      if (device.type === 'Coordinator') {
        coordinator++;
        continue;
      }
      if (device.disabled) {
        disabled++;
        continue;
      }
      if (device.type === 'Router') routers++;
      if (device.type === 'EndDevice') endDevices++;

      const state = states[device.friendly_name];
      const lqi = state?.linkquality as number | undefined;
      const battery = state?.battery as number | undefined;
      const lastSeen = state?.last_seen as string | undefined;

      deviceSummaries.push({
        name: device.friendly_name,
        ieee: device.ieee_address,
        type: device.type,
        lqi,
        battery,
        lastSeen,
        model: device.definition?.model,
      });

      // Check interview
      if (!device.interview_completed) {
        issues.push({
          device: device.friendly_name,
          type: 'interview_incomplete',
          severity: 'critical',
          message: 'Device interview not completed - may not function properly',
        });
      }

      // Check LQI
      if (lqi !== undefined) {
        if (lqi < LQI_CRITICAL) {
          issues.push({
            device: device.friendly_name,
            type: 'lqi_critical',
            severity: 'critical',
            message: `Critical signal quality (LQI: ${lqi})`,
            value: lqi,
          });
        } else if (lqi < LQI_LOW) {
          issues.push({
            device: device.friendly_name,
            type: 'lqi_low',
            severity: 'warning',
            message: `Low signal quality (LQI: ${lqi})`,
            value: lqi,
          });
        }
      }

      // Check battery
      if (battery !== undefined) {
        if (battery < BATTERY_CRITICAL) {
          issues.push({
            device: device.friendly_name,
            type: 'battery_critical',
            severity: 'critical',
            message: `Critical battery level (${battery}%)`,
            value: battery,
          });
        } else if (battery < BATTERY_LOW) {
          issues.push({
            device: device.friendly_name,
            type: 'battery_low',
            severity: 'warning',
            message: `Low battery level (${battery}%)`,
            value: battery,
          });
        }
      }

      // Check last seen (for battery devices primarily)
      if (lastSeen && device.power_source === 'Battery') {
        const lastSeenDate = new Date(lastSeen);
        const hoursSince = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60);
        if (hoursSince > STALE_HOURS * 7) { // 1 week for battery devices
          issues.push({
            device: device.friendly_name,
            type: 'stale',
            severity: 'warning',
            message: `Not seen for ${Math.round(hoursSince / 24)} days`,
            value: lastSeen,
          });
        }
      }
    }

    // Sort issues by severity
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      summary: {
        totalDevices: devices.length,
        routers,
        endDevices,
        coordinator,
        disabled,
        criticalIssues: issues.filter(i => i.severity === 'critical').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
      },
      issues,
      devices: deviceSummaries,
    };
  }

  /**
   * Collect device states over a duration
   */
  async collectDeviceStates(duration: number = 5000): Promise<Record<string, Z2MDeviceState>> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      const states: Record<string, Z2MDeviceState> = {};

      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(states);
      }, duration);

      ws.onerror = () => {
        clearTimeout(timeoutId);
        resolve(states);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          // Device state messages have the device name as topic (not starting with bridge/)
          if (data.topic && !data.topic.startsWith('bridge/') && typeof data.payload === 'object') {
            states[data.topic] = data.payload;
          }
        } catch {
          // Ignore
        }
      };
    });
  }

  // ============ Utility Methods ============

  async testConnection(): Promise<{ success: boolean; error?: string; info?: Z2MBridgeInfo }> {
    try {
      const info = await this.getBridgeInfo();
      return { success: true, info };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Find devices by type
   */
  async findDevicesByType(type: 'Router' | 'EndDevice' | 'Coordinator'): Promise<Z2MDevice[]> {
    const devices = await this.getDevices();
    return devices.filter(d => d.type === type);
  }

  /**
   * Search devices by name
   */
  async searchDevices(query: string): Promise<Z2MDevice[]> {
    const devices = await this.getDevices();
    const lowerQuery = query.toLowerCase();
    return devices.filter(d =>
      d.friendly_name.toLowerCase().includes(lowerQuery) ||
      d.definition?.model?.toLowerCase().includes(lowerQuery) ||
      d.definition?.vendor?.toLowerCase().includes(lowerQuery) ||
      d.definition?.description?.toLowerCase().includes(lowerQuery)
    );
  }
}

export default Z2MClient;
