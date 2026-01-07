#!/usr/bin/env bun
/**
 * Zigbee2MQTT CLI - A command-line interface for Zigbee2MQTT
 */

import { parseArgs } from 'util';
import { Z2MClient, type Z2MDevice } from '../lib/api';
import { resolveConfig, loadConfig, saveConfig, getConfigFilePath, configExists, type Config } from '../lib/config';
import pc from 'picocolors';
import Table from 'cli-table3';

// Color aliases for semantic usage
const c = {
  error: pc.red,
  success: pc.green,
  warn: pc.yellow,
  info: pc.cyan,
  bold: pc.bold,
  dim: pc.dim,
};

// Table helper - minimal style without borders
function createTable(head: string[]): Table.Table {
  return new Table({
    head: head.map(h => c.bold(h)),
    style: { head: [], border: [], compact: true },
    chars: {
      'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
      'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      'left': '  ', 'left-mid': '', 'mid': '', 'mid-mid': '',
      'right': '', 'right-mid': '', 'middle': '  ',
    },
  });
}

// Global options
let globalUrl: string | undefined;
let globalTimeout: number | undefined;
let outputJson = false;

function getClient(): Z2MClient {
  const config = resolveConfig({
    cliUrl: globalUrl,
    cliTimeout: globalTimeout,
  });
  return new Z2MClient(config);
}

function output(data: unknown): void {
  if (outputJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function error(message: string): void {
  console.error(c.error(`Error: ${message}`));
  process.exit(1);
}

function formatLastSeen(lastSeen: string | undefined): string {
  if (!lastSeen) return c.dim('--');
  const date = new Date(lastSeen);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 5) return c.success('now');
  if (diffMins < 60) return c.success(`${diffMins}m`);
  if (diffHours < 24) return c.info(`${diffHours}h`);
  if (diffDays < 7) return c.warn(`${diffDays}d`);
  return c.error(`${diffDays}d`);
}

function formatLqi(lqi: number | undefined): string {
  if (lqi === undefined) return c.dim('--');
  if (lqi < 30) return c.error(String(lqi));
  if (lqi < 50) return c.warn(String(lqi));
  return c.success(String(lqi));
}

function formatBattery(battery: number | undefined): string {
  if (battery === undefined) return c.dim('--');
  if (battery < 15) return c.error(`${battery}%`);
  if (battery < 25) return c.warn(`${battery}%`);
  return c.success(`${battery}%`);
}

// Types for network map
type NetworkNode = { ieeeAddr: string; friendlyName: string; type: string; networkAddress: number };
type NetworkLink = {
  source: { ieeeAddr: string };
  target: { ieeeAddr: string };
  lqi: number;
  relationship?: number;  // 0=parent, 1=child, 2=sibling, 3=none
  depth?: number;         // 1-254=hops from coordinator, 255=unknown
};
type NetworkMap = { nodes?: NetworkNode[]; links?: NetworkLink[] };
type NetworkMapResponse = { data?: { value?: NetworkMap } } & NetworkMap;

// Get parent routing relationships from network map
// Only uses links with relationship 0 or 1 (actual parent-child), ignores sibling links (2)
async function getParentRouting(client: Z2MClient): Promise<Map<string, { parent: string; lqi: number }>> {
  const parentOf = new Map<string, { parent: string; lqi: number }>();

  try {
    const response = await client.getNetworkMap(60000) as NetworkMapResponse;
    const map: NetworkMap = response.data?.value || response;

    if (!map.nodes || !map.links) return parentOf;

    const nodeByIeee = new Map<string, NetworkNode>();
    for (const node of map.nodes) {
      nodeByIeee.set(node.ieeeAddr, node);
    }

    // First pass: only process parent-child relationships (relationship 0 or 1)
    for (const link of map.links) {
      const sourceNode = nodeByIeee.get(link.source.ieeeAddr);
      const targetNode = nodeByIeee.get(link.target.ieeeAddr);
      if (!sourceNode || !targetNode) continue;

      // relationship 0: source reports target as its parent
      // relationship 1: source reports target as its child (with valid depth = actual parent-child link)
      // relationship 2: sibling/neighbor - skip these
      // relationship 3: unknown - skip these
      if (link.relationship === 0) {
        // Source's parent is target
        parentOf.set(sourceNode.friendlyName, { parent: targetNode.friendlyName, lqi: link.lqi });
      } else if (link.relationship === 1 && link.depth !== undefined && link.depth < 255) {
        // This is a parent-child link where source is child, target is parent
        // (depth < 255 indicates a real tree relationship, not just a neighbor)
        parentOf.set(sourceNode.friendlyName, { parent: targetNode.friendlyName, lqi: link.lqi });
      }
    }
  } catch {
    // Network map not available, return empty map
  }

  return parentOf;
}

// ============ Commands ============

const commands: Record<string, {
  description: string;
  usage?: string;
  action: (args: string[]) => Promise<void>;
}> = {
  // Connection
  'test': {
    description: 'Test connection to Zigbee2MQTT',
    action: async () => {
      const client = getClient();
      const result = await client.testConnection();
      if (result.success) {
        if (outputJson) {
          output(result);
        } else {
          console.log(c.success('✓ Connected to Zigbee2MQTT'));
          const table = createTable(['Property', 'Value']);
          table.push(
            ['Version', c.info(result.info?.version || 'unknown')],
            ['Channel', c.info(String(result.info?.network?.channel || 'unknown'))],
            ['Coordinator', result.info?.coordinator?.type || 'unknown'],
          );
          console.log(table.toString());
        }
      } else {
        error(result.error || 'Connection failed');
      }
    },
  },

  // Config commands
  'config:show': {
    description: 'Show current configuration',
    action: async () => {
      const config = loadConfig();
      const resolved = resolveConfig({});
      if (outputJson) {
        output({ file: getConfigFilePath(), config, resolved });
      } else {
        console.log(c.bold('\nConfiguration\n'));
        const table = createTable(['Source', 'URL', 'Timeout']);
        table.push(
          ['File', config.url || c.dim('not set'), config.timeout ? `${config.timeout}ms` : c.dim('not set')],
          ['Resolved', c.info(resolved.url || ''), `${resolved.timeout}ms`],
        );
        console.log(table.toString());

        if (config.coordinator_location) {
          console.log(c.bold('\nCoordinator Location'));
          console.log(`  Floor: ${c.info(config.coordinator_location.floor)}`);
          console.log(`  Sector: ${c.info(config.coordinator_location.sector)}`);
        }

        console.log(c.dim(`\nConfig file: ${getConfigFilePath()}`));
      }
    },
  },

  'config:set': {
    description: 'Set configuration URL',
    usage: '<url>',
    action: async (args) => {
      if (!args[0]) error('URL required');
      const config = loadConfig();
      config.url = args[0];
      saveConfig(config);
      output(outputJson ? { success: true, config } : c.success(`Configuration saved: ${args[0]}`));
    },
  },

  'config:path': {
    description: 'Show config file path',
    action: async () => {
      const path = getConfigFilePath();
      output(outputJson ? { path } : path);
    },
  },

  // Device commands
  'device:list': {
    description: 'List all devices',
    usage: '[--type=<Router|EndDevice>] [--routing]',
    action: async (args) => {
      const client = getClient();
      let devices = await client.getDevices();
      const showRouting = args.includes('--routing');

      // Fetch states, and optionally routing info
      const states = await client.collectDeviceStates(4000);
      let parentOf = new Map<string, { parent: string; lqi: number }>();
      if (showRouting) {
        console.error(c.dim('Fetching network map for routing info...'));
        parentOf = await getParentRouting(client);
      }

      // Filter by type if specified
      const typeArg = args.find(a => a.startsWith('--type='));
      if (typeArg) {
        const filterType = typeArg.split('=')[1];
        devices = devices.filter(d => d.type.toLowerCase() === filterType.toLowerCase());
      }

      if (outputJson) {
        output(devices.map(d => ({
          ...d,
          state: states[d.friendly_name] || null,
          ...(showRouting && { routes_through: parentOf.get(d.friendly_name)?.parent || null }),
        })));
      } else {
        const routers = devices.filter(d => d.type === 'Router' && !d.disabled);
        const endDevices = devices.filter(d => d.type === 'EndDevice' && !d.disabled);
        const disabled = devices.filter(d => d.disabled);

        console.log(c.bold(`\nDevices (${devices.length})`));
        console.log(c.dim(`${routers.length} routers, ${endDevices.length} end devices\n`));

        // Routers table
        if (routers.length > 0) {
          console.log(c.bold('Routers'));
          const headers = showRouting
            ? ['Name', 'Parent', 'LQI', 'Model', 'Last Seen']
            : ['Name', 'LQI', 'Model', 'Last Seen'];
          const table = createTable(headers);
          for (const d of routers) {
            const state = states[d.friendly_name];
            const routing = parentOf.get(d.friendly_name);
            const row = showRouting
              ? [
                  d.friendly_name,
                  routing ? c.info(routing.parent) : c.dim('Coordinator'),
                  formatLqi(state?.linkquality as number),
                  c.dim(d.definition?.model || '--'),
                  formatLastSeen(state?.last_seen as string),
                ]
              : [
                  d.friendly_name,
                  formatLqi(state?.linkquality as number),
                  c.dim(d.definition?.model || '--'),
                  formatLastSeen(state?.last_seen as string),
                ];
            table.push(row);
          }
          console.log(table.toString());
          console.log();
        }

        // End devices table
        if (endDevices.length > 0) {
          console.log(c.bold('End Devices'));
          const headers = showRouting
            ? ['Name', 'Parent', 'LQI', 'Battery', 'Model', 'Last Seen']
            : ['Name', 'LQI', 'Battery', 'Model', 'Last Seen'];
          const table = createTable(headers);
          for (const d of endDevices) {
            const state = states[d.friendly_name];
            const routing = parentOf.get(d.friendly_name);
            const row = showRouting
              ? [
                  d.friendly_name,
                  routing ? c.info(routing.parent) : c.dim('Coordinator'),
                  formatLqi(state?.linkquality as number),
                  formatBattery(state?.battery as number),
                  c.dim(d.definition?.model || '--'),
                  formatLastSeen(state?.last_seen as string),
                ]
              : [
                  d.friendly_name,
                  formatLqi(state?.linkquality as number),
                  formatBattery(state?.battery as number),
                  c.dim(d.definition?.model || '--'),
                  formatLastSeen(state?.last_seen as string),
                ];
            table.push(row);
          }
          console.log(table.toString());
        }

        // Disabled
        if (disabled.length > 0) {
          console.log(c.bold('\nDisabled'));
          for (const d of disabled) {
            console.log(`  ${c.dim(d.friendly_name)}`);
          }
        }
      }
    },
  },

  'device:get': {
    description: 'Get device info and state',
    usage: '<name> [--routing]',
    action: async (args) => {
      const deviceName = args.find(a => !a.startsWith('--'));
      if (!deviceName) error('Device name required');
      const showRouting = args.includes('--routing');

      const client = getClient();
      const device = await client.getDevice(deviceName);
      if (!device) error(`Device "${deviceName}" not found`);

      const state = await client.getDeviceState(deviceName);
      let routing: { parent: string; lqi: number } | undefined;
      if (showRouting) {
        console.error(c.dim('Fetching network map for routing info...'));
        const parentOf = await getParentRouting(client);
        routing = parentOf.get(deviceName);
      }

      if (outputJson) {
        output({
          device,
          state,
          ...(showRouting && { routes_through: routing?.parent || null }),
        });
      } else {
        const d = device!;
        console.log(c.bold(`\n${d.friendly_name}\n`));

        const infoTable = createTable(['Property', 'Value']);
        infoTable.push(
          ['IEEE Address', c.info(d.ieee_address)],
          ['Type', d.type],
        );
        if (showRouting) {
          infoTable.push(['Routes Through', routing ? c.info(routing.parent) : c.dim('Coordinator')]);
        }
        infoTable.push(
          ['Model', d.definition?.model || 'unknown'],
          ['Vendor', d.definition?.vendor || 'unknown'],
          ['Power Source', d.power_source || 'unknown'],
          ['Interview', d.interview_completed ? c.success('completed') : c.error('incomplete')],
          ['Disabled', d.disabled ? c.warn('yes') : 'no'],
        );
        console.log(infoTable.toString());

        if (state) {
          console.log(c.bold('\nState'));
          const stateTable = createTable(['Property', 'Value']);
          const importantKeys = ['linkquality', 'battery', 'state', 'temperature', 'humidity', 'occupancy', 'contact', 'running_state', 'occupied_heating_setpoint'];
          for (const key of importantKeys) {
            if (state[key] !== undefined) {
              let value = String(state[key]);
              if (key === 'linkquality') value = formatLqi(state[key] as number);
              if (key === 'battery') value = formatBattery(state[key] as number);
              stateTable.push([key, value]);
            }
          }
          console.log(stateTable.toString());

          const otherKeys = Object.keys(state).filter(k => !importantKeys.includes(k) && k !== 'last_seen');
          if (otherKeys.length > 0) {
            console.log(c.dim(`\nOther: ${otherKeys.join(', ')}`));
          }
        }
      }
    },
  },

  'device:set': {
    description: 'Set device state',
    usage: '<name> <json>',
    action: async (args) => {
      if (!args[0]) error('Device name required');
      if (!args[1]) error('JSON payload required');
      const client = getClient();
      const payload = JSON.parse(args[1]);
      await client.setDeviceState(args[0], payload);
      output(outputJson ? { success: true } : c.success(`Command sent to ${args[0]}`));
    },
  },

  'device:rename': {
    description: 'Rename a device',
    usage: '<old-name> <new-name>',
    action: async (args) => {
      if (!args[0]) error('Current device name required');
      if (!args[1]) error('New device name required');
      const client = getClient();
      await client.renameDevice(args[0], args[1]);
      output(outputJson ? { success: true } : c.success(`Device renamed: ${args[0]} → ${args[1]}`));
    },
  },

  'device:remove': {
    description: 'Remove a device from the network',
    usage: '<name> [--force]',
    action: async (args) => {
      if (!args[0]) error('Device name required');
      const force = args.includes('--force');
      const client = getClient();
      await client.removeDevice(args[0], force);
      output(outputJson ? { success: true } : c.success(`Device ${args[0]} removed`));
    },
  },

  'device:search': {
    description: 'Search devices by name/model/vendor',
    usage: '<query>',
    action: async (args) => {
      if (!args[0]) error('Search query required');
      const client = getClient();
      const devices = await client.searchDevices(args[0]);
      if (outputJson) {
        output(devices);
      } else {
        console.log(c.bold(`\nFound ${devices.length} device(s)\n`));
        const table = createTable(['Name', 'Type', 'Model', 'Vendor']);
        for (const d of devices) {
          table.push([
            d.friendly_name,
            d.type,
            d.definition?.model || '--',
            d.definition?.vendor || '--',
          ]);
        }
        console.log(table.toString());
      }
    },
  },

  'device:describe': {
    description: 'Set device description',
    usage: '<name> <description>',
    action: async (args) => {
      if (!args[0]) error('Device name required');
      if (!args[1]) error('Description required');
      const client = getClient();
      const description = args.slice(1).join(' ');
      await client.setDeviceOptions(args[0], { description });
      output(outputJson ? { success: true, device: args[0], description } : c.success(`Description set for ${args[0]}`));
    },
  },

  // Group commands
  'group:list': {
    description: 'List all groups',
    action: async () => {
      const client = getClient();
      const groups = await client.getGroups();
      if (outputJson) {
        output(groups);
      } else {
        console.log(c.bold('\nGroups\n'));
        if (groups.length === 0) {
          console.log(c.dim('  No groups defined'));
        } else {
          const table = createTable(['ID', 'Name', 'Members']);
          for (const g of groups) {
            table.push([String(g.id), g.friendly_name, String(g.members.length)]);
          }
          console.log(table.toString());
        }
      }
    },
  },

  'group:get': {
    description: 'Get group details',
    usage: '<name-or-id>',
    action: async (args) => {
      if (!args[0]) error('Group name or ID required');
      const client = getClient();
      const group = await client.getGroup(args[0]);
      if (!group) error(`Group "${args[0]}" not found`);

      if (outputJson) {
        output(group);
      } else {
        console.log(c.bold(`\n${group.friendly_name}\n`));
        const table = createTable(['Property', 'Value']);
        table.push(
          ['ID', String(group.id)],
          ['Members', String(group.members.length)],
        );
        console.log(table.toString());

        if (group.members.length > 0) {
          console.log(c.bold('\nMembers'));
          const membersTable = createTable(['Device', 'Endpoint']);
          for (const m of group.members) {
            membersTable.push([m.ieee_address, String(m.endpoint)]);
          }
          console.log(membersTable.toString());
        }
      }
    },
  },

  'group:set': {
    description: 'Set group state',
    usage: '<name-or-id> <json>',
    action: async (args) => {
      if (!args[0]) error('Group name or ID required');
      if (!args[1]) error('JSON payload required');
      const client = getClient();
      const payload = JSON.parse(args[1]);
      await client.setGroupState(args[0], payload);
      output(outputJson ? { success: true } : c.success(`Command sent to group ${args[0]}`));
    },
  },

  // Bridge commands
  'bridge:info': {
    description: 'Get bridge information',
    action: async () => {
      const client = getClient();
      const info = await client.getBridgeInfo();
      if (outputJson) {
        output(info);
      } else {
        console.log(c.bold('\nBridge Information\n'));
        const table = createTable(['Property', 'Value']);
        table.push(
          ['Version', c.info(info.version)],
          ['Commit', c.dim(info.commit?.substring(0, 8) || 'unknown')],
          ['Coordinator', info.coordinator?.type || 'unknown'],
          ['IEEE Address', c.info(info.coordinator?.ieee_address || 'unknown')],
          ['Channel', c.info(String(info.network?.channel))],
          ['PAN ID', String(info.network?.pan_id)],
          ['Log Level', info.log_level],
          ['Permit Join', info.permit_join ? c.success('enabled') : 'disabled'],
        );
        console.log(table.toString());

        if (info.restart_required) {
          console.log(c.warn('\n  ⚠ Restart required'));
        }
      }
    },
  },

  'bridge:state': {
    description: 'Get bridge state',
    action: async () => {
      const client = getClient();
      const state = await client.getBridgeState();
      if (outputJson) {
        output(state);
      } else {
        const status = state.state === 'online' ? c.success('online') : c.error(state.state || 'unknown');
        console.log(`Bridge state: ${status}`);
      }
    },
  },

  'bridge:restart': {
    description: 'Restart the bridge',
    action: async () => {
      const client = getClient();
      await client.restartBridge();
      output(outputJson ? { success: true } : c.success('Bridge restart initiated'));
    },
  },

  'bridge:permitjoin': {
    description: 'Enable/disable permit join (optionally on specific device)',
    usage: '<on|off> [time] [--device=<name>]',
    action: async (args) => {
      if (!args[0]) error('Specify on or off');
      const permit = args[0].toLowerCase() === 'on' || args[0] === 'true';

      // Parse time and device from args
      let time: number | undefined;
      let device: string | undefined;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--device=')) {
          device = arg.slice('--device='.length);
        } else if (arg.startsWith('-d=')) {
          device = arg.slice('-d='.length);
        } else if (!isNaN(parseInt(arg))) {
          time = parseInt(arg);
        } else {
          // Assume it's a device name without flag (for convenience)
          device = arg;
        }
      }

      const client = getClient();
      await client.permitJoin(permit, time, device);

      const parts = [`Permit join: ${permit ? 'enabled' : 'disabled'}`];
      if (time) parts.push(`for ${time}s`);
      if (device) parts.push(`on ${device}`);

      output(outputJson
        ? { success: true, permit_join: permit, time, device }
        : c.success(parts.join(' ')));
    },
  },

  'bridge:loglevel': {
    description: 'Set log level',
    usage: '<debug|info|warning|error>',
    action: async (args) => {
      if (!args[0]) error('Log level required');
      const level = args[0] as 'debug' | 'info' | 'warning' | 'error';
      const client = getClient();
      await client.setLogLevel(level);
      output(outputJson ? { success: true } : c.success(`Log level set to: ${level}`));
    },
  },

  // Network commands
  'network:map': {
    description: 'Get network map',
    action: async () => {
      const client = getClient();
      console.error(c.dim('Fetching network map (this may take a moment)...'));
      const response = await client.getNetworkMap(60000) as { data?: { value?: { nodes?: Array<{ ieeeAddr: string; friendlyName: string; type: string; networkAddress: number; failed?: string[] }>; links?: Array<{ source: { ieeeAddr: string }; target: { ieeeAddr: string }; lqi: number; depth: number }> } } };
      // Extract the actual map data from the response wrapper
      const map = response.data?.value || response as { nodes?: Array<{ ieeeAddr: string; friendlyName: string; type: string; networkAddress: number; failed?: string[] }>; links?: Array<{ source: { ieeeAddr: string }; target: { ieeeAddr: string }; lqi: number; depth: number }> };
      if (outputJson) {
        output(response);
      } else {
        console.log(c.bold('\nNetwork Map\n'));

        // Nodes summary
        if (map.nodes && map.nodes.length > 0) {
          const coordinator = map.nodes.filter(n => n.type === 'Coordinator');
          const routers = map.nodes.filter(n => n.type === 'Router');
          const endDevices = map.nodes.filter(n => n.type === 'EndDevice');

          const summaryTable = createTable(['Type', 'Count']);
          summaryTable.push(
            ['Coordinator', String(coordinator.length)],
            ['Routers', String(routers.length)],
            ['End Devices', String(endDevices.length)],
            ['Total', c.bold(String(map.nodes.length))],
          );
          console.log(summaryTable.toString());

          // Links summary
          if (map.links && map.links.length > 0) {
            const avgLqi = Math.round(map.links.reduce((sum, l) => sum + l.lqi, 0) / map.links.length);
            const weakLinks = map.links.filter(l => l.lqi < 50).length;

            console.log(c.bold('\nLinks'));
            const linksTable = createTable(['Metric', 'Value']);
            linksTable.push(
              ['Total Links', String(map.links.length)],
              ['Average LQI', formatLqi(avgLqi)],
              ['Weak Links (LQI < 50)', weakLinks > 0 ? c.warn(String(weakLinks)) : c.success('0')],
            );
            console.log(linksTable.toString());
          }
        } else {
          console.log(c.dim('  No network map data available'));
        }

        console.log(c.dim('\nUse -j for full network map data'));
      }
    },
  },

  'network:routes': {
    description: 'Show routing table (parent-child relationships)',
    usage: '[--router=<name>]',
    action: async () => {
      const client = getClient();
      console.error(c.dim('Fetching network map (this may take a moment)...'));

      type NetworkNode = { ieeeAddr: string; friendlyName: string; type: string; networkAddress: number };
      type NetworkLink = {
        source: { ieeeAddr: string; networkAddress: number };
        target: { ieeeAddr: string; networkAddress: number };
        lqi: number;
        depth: number;
        relationship?: number;  // 0=parent, 1=child, 2=sibling, 3=none, 4=previous child
        routes: Array<{ destinationAddress: number; status: string; nextHop: number }>;
      };
      type NetworkMap = { nodes?: NetworkNode[]; links?: NetworkLink[] };
      type NetworkMapResponse = { data?: { value?: NetworkMap } } & NetworkMap;

      const response = await client.getNetworkMap(60000) as NetworkMapResponse;
      // Extract the actual map data from the response wrapper
      const map: NetworkMap = response.data?.value || response;

      if (!map.nodes || !map.links || map.nodes.length === 0) {
        error('No network map data available. Try again or check Z2M logs.');
      }

      // Build lookup maps
      const nodeByIeee = new Map<string, NetworkNode>();
      const nodeByAddr = new Map<number, NetworkNode>();
      for (const node of map.nodes!) {
        nodeByIeee.set(node.ieeeAddr, node);
        nodeByAddr.set(node.networkAddress, node);
      }

      // Build parent relationships from links
      // Only use links with relationship 0 (parent) or 1 (child with valid depth)
      // Ignore relationship 2 (sibling) as those are neighbors, not routing paths
      const parentOf = new Map<string, { parent: NetworkNode; lqi: number }>();
      const childrenOf = new Map<string, Array<{ child: NetworkNode; lqi: number }>>();

      for (const link of map.links!) {
        const sourceNode = nodeByIeee.get(link.source.ieeeAddr);
        const targetNode = nodeByIeee.get(link.target.ieeeAddr);

        if (!sourceNode || !targetNode) continue;

        // relationship 0: source reports target as its parent
        // relationship 1: source reports target as its child (with valid depth = actual parent-child)
        // relationship 2: sibling/neighbor - skip these
        // relationship 3+: unknown/other - skip these
        const isParentLink = link.relationship === 0;
        const isChildLink = link.relationship === 1 && link.depth !== undefined && link.depth < 255;

        if (isParentLink || isChildLink) {
          // source routes through target
          parentOf.set(sourceNode.ieeeAddr, { parent: targetNode, lqi: link.lqi });

          if (!childrenOf.has(targetNode.ieeeAddr)) {
            childrenOf.set(targetNode.ieeeAddr, []);
          }
          childrenOf.get(targetNode.ieeeAddr)!.push({ child: sourceNode, lqi: link.lqi });
        }
      }

      if (outputJson) {
        const routes: Array<{
          device: string;
          ieee: string;
          type: string;
          parent: string | null;
          parentIeee: string | null;
          lqi: number | null;
          children: Array<{ name: string; ieee: string; type: string; lqi: number }>;
        }> = [];

        for (const node of map.nodes!) {
          const parentInfo = parentOf.get(node.ieeeAddr);
          const children = childrenOf.get(node.ieeeAddr) || [];

          routes.push({
            device: node.friendlyName,
            ieee: node.ieeeAddr,
            type: node.type,
            parent: parentInfo?.parent.friendlyName || null,
            parentIeee: parentInfo?.parent.ieeeAddr || null,
            lqi: parentInfo?.lqi || null,
            children: children.map(c => ({
              name: c.child.friendlyName,
              ieee: c.child.ieeeAddr,
              type: c.child.type,
              lqi: c.lqi,
            })),
          });
        }

        output(routes);
      } else {
        console.log(c.bold('\nRouting Table\n'));

        // Show coordinator and routers with their children
        const coordinator = map.nodes!.find(n => n.type === 'Coordinator');
        const routers = map.nodes!.filter(n => n.type === 'Router');

        // Helper to display a router and its children
        const displayRouter = (router: NetworkNode, indent: string = '') => {
          const children = childrenOf.get(router.ieeeAddr) || [];
          const routerParent = parentOf.get(router.ieeeAddr);

          // Router header
          const routerLqi = routerParent ? formatLqi(routerParent.lqi) : '';
          const childCount = children.length;
          console.log(`${indent}${c.info(router.friendlyName)} ${c.dim(`(${router.type})`)} ${routerLqi ? `LQI: ${routerLqi}` : ''}`);

          if (childCount > 0) {
            // Group children by type
            const routerChildren = children.filter(c => c.child.type === 'Router');
            const endDeviceChildren = children.filter(c => c.child.type === 'EndDevice');

            // Show end devices first
            for (const { child, lqi } of endDeviceChildren) {
              console.log(`${indent}  ├─ ${child.friendlyName} ${c.dim('(EndDevice)')} LQI: ${formatLqi(lqi)}`);
            }

            // Show router children (they'll be expanded separately)
            for (const { child, lqi } of routerChildren) {
              console.log(`${indent}  ├─ ${c.info(child.friendlyName)} ${c.dim('(Router)')} LQI: ${formatLqi(lqi)}`);
            }
          } else {
            console.log(`${indent}  ${c.dim('(no devices routing through this)')}`);
          }
        };

        // Show coordinator first
        if (coordinator) {
          console.log(c.bold('Coordinator'));
          displayRouter(coordinator);
          console.log();
        }

        // Show each router grouped by their parent
        console.log(c.bold('Routers'));
        const routerTable = createTable(['Router', 'Parent', 'LQI', 'Children']);

        for (const router of routers) {
          const parentInfo = parentOf.get(router.ieeeAddr);
          const children = childrenOf.get(router.ieeeAddr) || [];

          routerTable.push([
            c.info(router.friendlyName),
            parentInfo?.parent.friendlyName || c.dim('Coordinator'),
            formatLqi(parentInfo?.lqi),
            String(children.length),
          ]);
        }
        console.log(routerTable.toString());

        // Show all device routes
        console.log(c.bold('\nDevice Routes'));
        const deviceTable = createTable(['Device', 'Type', 'Routes Through', 'LQI']);

        // Sort: routers first, then end devices, then by name
        const sortedNodes = [...map.nodes!]
          .filter(n => n.type !== 'Coordinator')
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'Router' ? -1 : 1;
            return a.friendlyName.localeCompare(b.friendlyName);
          });

        for (const node of sortedNodes) {
          const parentInfo = parentOf.get(node.ieeeAddr);
          deviceTable.push([
            node.type === 'Router' ? c.info(node.friendlyName) : node.friendlyName,
            node.type === 'Router' ? c.info(node.type) : c.dim(node.type),
            parentInfo?.parent.friendlyName || c.dim('Coordinator (direct)'),
            formatLqi(parentInfo?.lqi),
          ]);
        }
        console.log(deviceTable.toString());
      }
    },
  },

  'network:routing-analysis': {
    description: 'Analyze routing efficiency based on device locations',
    action: async () => {
      const client = getClient();
      console.error(c.dim('Fetching network map and device data...'));

      // Sector to grid coordinates mapping
      // Grid: West(0)-Center(1)-East(2) on X axis, South(0)-Center(1)-North(2) on Y axis
      const sectorCoords: Record<string, [number, number]> = {
        'south-west': [0, 0], 'south-center': [1, 0], 'south-east': [2, 0],
        'center-west': [0, 1], 'center': [1, 1], 'center-east': [2, 1],
        'north-west': [0, 2], 'north-center': [1, 2], 'north-east': [2, 2],
      };
      const floorNum: Record<string, number> = {
        'Basement': 0, 'Ground Floor': 1, 'Upper Floor': 2,
      };

      // Calculate Manhattan distance with floor weight
      const calcDistance = (
        a: { floor: string; sector: string },
        b: { floor: string; sector: string }
      ): number => {
        const [ax, ay] = sectorCoords[a.sector] || [1, 1];
        const [bx, by] = sectorCoords[b.sector] || [1, 1];
        const az = floorNum[a.floor] ?? 1;
        const bz = floorNum[b.floor] ?? 1;
        // Floor transitions are harder for RF, weight them 1.5x
        return Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz) * 1.5;
      };

      // Parse YAML-like description to extract location
      const parseLocation = (description: string | undefined): { floor?: string; sector?: string } | null => {
        if (!description) return null;
        const lines = description.split('\n');
        const result: Record<string, string> = {};
        for (const line of lines) {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match) {
            result[match[1]] = match[2].trim();
          }
        }
        if (result.floor && result.sector) {
          return { floor: result.floor, sector: result.sector };
        }
        return null;
      };

      // Get devices with their descriptions
      const devices = await client.getDevices();
      const deviceLocations = new Map<string, { floor: string; sector: string }>();

      for (const device of devices) {
        // Description is in device options, need to fetch via API
        // For now, we'll use a workaround - descriptions are stored but not directly exposed
        // We need to get the full device info which includes description
      }

      // Fetch full device data including descriptions
      const fullDevices = await client.getDevicesRaw();

      // Get coordinator location from config
      const config = loadConfig();
      const coordinatorLocation = config.coordinator_location;

      for (const device of fullDevices) {
        // Coordinator doesn't support descriptions, use config if set
        if (device.type === 'Coordinator' && coordinatorLocation) {
          deviceLocations.set(device.friendly_name, coordinatorLocation);
          continue;
        }
        const loc = parseLocation(device.description);
        if (loc && loc.floor && loc.sector) {
          deviceLocations.set(device.friendly_name, { floor: loc.floor, sector: loc.sector });
        }
      }

      if (deviceLocations.size === 0) {
        error('No device locations found. Run sector update script first to set device descriptions with floor/sector info.');
      }

      // Get network map for routing info
      type NetworkNode = { ieeeAddr: string; friendlyName: string; type: string; networkAddress: number };
      type NetworkLink = { source: { ieeeAddr: string }; target: { ieeeAddr: string }; lqi: number };
      type NetworkMap = { nodes?: NetworkNode[]; links?: NetworkLink[] };
      type NetworkMapResponse = { data?: { value?: NetworkMap } } & NetworkMap;

      const response = await client.getNetworkMap(60000) as NetworkMapResponse;
      const map: NetworkMap = response.data?.value || response;

      if (!map.nodes || !map.links) {
        error('No network map data available');
      }

      // Build lookup maps
      const nodeByIeee = new Map<string, NetworkNode>();
      for (const node of map.nodes!) {
        nodeByIeee.set(node.ieeeAddr, node);
      }

      // Build parent relationships
      const parentOf = new Map<string, { parent: NetworkNode; lqi: number }>();
      for (const link of map.links!) {
        const sourceNode = nodeByIeee.get(link.source.ieeeAddr);
        const targetNode = nodeByIeee.get(link.target.ieeeAddr);
        if (sourceNode && targetNode) {
          parentOf.set(sourceNode.friendlyName, { parent: targetNode, lqi: link.lqi });
        }
      }

      // Get all routers with locations
      const routers = map.nodes!
        .filter(n => n.type === 'Router' || n.type === 'Coordinator')
        .map(n => ({
          name: n.friendlyName,
          type: n.type,
          location: deviceLocations.get(n.friendlyName),
        }))
        .filter(r => r.location);

      // Analyze routing for each device
      interface RoutingAnalysis {
        device: string;
        deviceLocation: { floor: string; sector: string };
        currentRouter: string;
        currentRouterLocation?: { floor: string; sector: string };
        currentDistance: number;
        currentLqi: number;
        betterOptions: Array<{
          router: string;
          location: { floor: string; sector: string };
          distance: number;
        }>;
      }

      // Build initial analysis for all devices
      interface DeviceCandidate {
        device: string;
        deviceLoc: { floor: string; sector: string };
        parentInfo: { parent: NetworkNode; lqi: number };
        currentDistance: number;
        potentialRouters: Array<{ router: string; distance: number; location: { floor: string; sector: string } }>;
      }

      const candidateMap = new Map<string, DeviceCandidate>();

      for (const node of map.nodes!) {
        if (node.type === 'Coordinator') continue;

        const deviceLoc = deviceLocations.get(node.friendlyName);
        if (!deviceLoc) continue;

        const parentInfo = parentOf.get(node.friendlyName);
        if (!parentInfo) continue;

        const parentLoc = deviceLocations.get(parentInfo.parent.friendlyName);
        const currentDistance = parentLoc ? calcDistance(deviceLoc, parentLoc) : 999;

        const potentialRouters = routers
          .filter(r => r.name !== parentInfo.parent.friendlyName && r.name !== node.friendlyName)
          .map(r => ({
            router: r.name,
            location: r.location!,
            distance: calcDistance(deviceLoc, r.location!),
          }))
          .filter(r => r.distance < currentDistance * 0.7)
          .sort((a, b) => a.distance - b.distance);

        candidateMap.set(node.friendlyName, { device: node.friendlyName, deviceLoc, parentInfo, currentDistance, potentialRouters });
      }

      // === CONFLICT-AWARE OPTIMIZATION ===

      // Step 1: Identify conflicts (A wants B AND B wants A)
      const conflicts = new Map<string, Set<string>>();
      for (const [device, candidate] of candidateMap) {
        const conflictSet = new Set<string>();
        for (const router of candidate.potentialRouters) {
          const routerCandidate = candidateMap.get(router.router);
          if (routerCandidate?.potentialRouters.some(r => r.router === device)) {
            conflictSet.add(router.router);
          }
        }
        if (conflictSet.size > 0) conflicts.set(device, conflictSet);
      }

      // Step 2: Resolve conflicts by maximizing total improvement
      const assignedRouting = new Map<string, string>();
      const resolvedDevices = new Set<string>();

      // Find connected components of conflicts
      const visited = new Set<string>();
      const components: string[][] = [];

      for (const device of conflicts.keys()) {
        if (visited.has(device)) continue;
        const component: string[] = [];
        const queue = [device];
        while (queue.length > 0) {
          const d = queue.shift()!;
          if (visited.has(d)) continue;
          visited.add(d);
          component.push(d);
          for (const conflicting of conflicts.get(d) || []) {
            if (!visited.has(conflicting)) queue.push(conflicting);
          }
        }
        components.push(component);
      }

      // Resolve each conflict component
      for (const component of components) {
        if (component.length === 2) {
          // Simple pair: compare all options
          const [a, b] = component;
          const candA = candidateMap.get(a)!;
          const candB = candidateMap.get(b)!;

          const improvementAtoB = candA.currentDistance - (candA.potentialRouters.find(r => r.router === b)?.distance || candA.currentDistance);
          const improvementBtoA = candB.currentDistance - (candB.potentialRouters.find(r => r.router === a)?.distance || candB.currentDistance);

          // A's next best (excluding B)
          const aNextBest = candA.potentialRouters.find(r => r.router !== b);
          const aNextImprovement = aNextBest ? candA.currentDistance - aNextBest.distance : 0;

          // B's next best (excluding A)
          const bNextBest = candB.potentialRouters.find(r => r.router !== a);
          const bNextImprovement = bNextBest ? candB.currentDistance - bNextBest.distance : 0;

          // Option 1: A→B, B uses next best
          const option1 = improvementAtoB + bNextImprovement;
          // Option 2: B→A, A uses next best
          const option2 = improvementBtoA + aNextImprovement;
          // Option 3: Neither (both use next best)
          const option3 = aNextImprovement + bNextImprovement;

          if (option1 >= option2 && option1 >= option3 && option1 > 0) {
            assignedRouting.set(a, b);
            if (bNextBest) assignedRouting.set(b, bNextBest.router);
          } else if (option2 >= option1 && option2 >= option3 && option2 > 0) {
            assignedRouting.set(b, a);
            if (aNextBest) assignedRouting.set(a, aNextBest.router);
          } else {
            if (aNextBest) assignedRouting.set(a, aNextBest.router);
            if (bNextBest) assignedRouting.set(b, bNextBest.router);
          }
          resolvedDevices.add(a);
          resolvedDevices.add(b);
        } else if (component.length > 2) {
          // Larger component: use greedy with total improvement consideration
          // Sort by potential improvement, resolve one at a time
          const sorted = component
            .map(d => ({ device: d, candidate: candidateMap.get(d)! }))
            .sort((a, b) => {
              const aImprove = a.candidate.currentDistance - (a.candidate.potentialRouters[0]?.distance || a.candidate.currentDistance);
              const bImprove = b.candidate.currentDistance - (b.candidate.potentialRouters[0]?.distance || b.candidate.currentDistance);
              return bImprove - aImprove;
            });

          for (const { device, candidate } of sorted) {
            const validRouter = candidate.potentialRouters.find(r => {
              if (assignedRouting.get(r.router) === device) return false;
              let current = assignedRouting.get(r.router);
              const seen = new Set<string>();
              while (current && !seen.has(current)) {
                if (current === device) return false;
                seen.add(current);
                current = assignedRouting.get(current);
              }
              return true;
            });
            if (validRouter) assignedRouting.set(device, validRouter.router);
            resolvedDevices.add(device);
          }
        }
      }

      // Step 3: Propagate - iterate until stable
      let changed = true;
      while (changed) {
        changed = false;
        for (const [device, candidate] of candidateMap) {
          if (assignedRouting.has(device)) continue;

          // Check if any now-assigned router is a valid option
          const validRouter = candidate.potentialRouters.find(r => {
            if (assignedRouting.get(r.router) === device) return false;
            let current = assignedRouting.get(r.router);
            const seen = new Set<string>();
            while (current && !seen.has(current)) {
              if (current === device) return false;
              seen.add(current);
              current = assignedRouting.get(current);
            }
            return true;
          });

          if (validRouter) {
            assignedRouting.set(device, validRouter.router);
            changed = true;
          }
        }
      }

      // Step 4: Build final results
      const anomalies: RoutingAnalysis[] = [];
      const optimal: string[] = [];

      for (const [device, candidate] of candidateMap) {
        const assignedRouter = assignedRouting.get(device);
        const parentLoc = deviceLocations.get(candidate.parentInfo.parent.friendlyName);

        if (assignedRouter) {
          // Filter to show only valid options (no cycles)
          const validRouters = candidate.potentialRouters.filter(r => {
            if (assignedRouting.get(r.router) === device) return false;
            let current = assignedRouting.get(r.router);
            const seen = new Set<string>();
            while (current && !seen.has(current)) {
              if (current === device) return false;
              seen.add(current);
              current = assignedRouting.get(current);
            }
            return true;
          });

          anomalies.push({
            device: candidate.device,
            deviceLocation: candidate.deviceLoc,
            currentRouter: candidate.parentInfo.parent.friendlyName,
            currentRouterLocation: parentLoc,
            currentDistance: candidate.currentDistance,
            currentLqi: candidate.parentInfo.lqi,
            betterOptions: validRouters.slice(0, 3),
          });
        } else {
          optimal.push(device);
        }
      }

      if (outputJson) {
        output({
          summary: {
            totalAnalyzed: anomalies.length + optimal.length,
            anomalies: anomalies.length,
            optimal: optimal.length,
          },
          anomalies,
          optimal,
        });
      } else {
        console.log(c.bold('\nRouting Analysis\n'));

        const summaryTable = createTable(['Metric', 'Value']);
        summaryTable.push(
          ['Devices with location', String(deviceLocations.size)],
          ['Routing anomalies', anomalies.length > 0 ? c.warn(String(anomalies.length)) : c.success('0')],
          ['Optimal routing', c.success(String(optimal.length))],
        );
        console.log(summaryTable.toString());

        if (anomalies.length > 0) {
          console.log(c.bold('\nRouting Anomalies\n'));
          console.log(c.dim('Devices routing through distant routers when closer ones exist:\n'));

          for (const a of anomalies.sort((x, y) => y.currentDistance - x.currentDistance)) {
            const deviceSector = `${a.deviceLocation.floor}, ${a.deviceLocation.sector}`;
            const routerSector = a.currentRouterLocation
              ? `${a.currentRouterLocation.floor}, ${a.currentRouterLocation.sector}`
              : 'unknown';

            console.log(`  ${c.warn(a.device)}`);
            console.log(`    Location: ${c.info(deviceSector)}`);
            console.log(`    Current:  ${a.currentRouter} (${routerSector}) ${c.dim(`dist=${a.currentDistance.toFixed(1)}, LQI=${a.currentLqi}`)}`);
            console.log(`    Better:`);
            for (const opt of a.betterOptions) {
              const optSector = `${opt.location.floor}, ${opt.location.sector}`;
              const improvement = ((a.currentDistance - opt.distance) / a.currentDistance * 100).toFixed(0);
              console.log(`      ${c.success('→')} ${opt.router} (${optSector}) ${c.success(`dist=${opt.distance.toFixed(1)}`)} ${c.dim(`${improvement}% closer`)}`);
            }
            console.log();
          }
        } else {
          console.log(c.success('\n✓ All devices have optimal routing!'));
        }

        if (deviceLocations.size < devices.length - 1) {
          const missing = devices.length - 1 - deviceLocations.size;
          console.log(c.dim(`\nNote: ${missing} devices missing location data (no sector in description)`));
        }
      }
    },
  },

  'network:diagnose': {
    description: 'Run network diagnostics',
    action: async () => {
      const client = getClient();
      console.error(c.dim('Collecting device states (5s)...'));
      const report = await client.diagnose();

      if (outputJson) {
        output(report);
      } else {
        console.log(c.bold('\nNetwork Diagnostic Report\n'));

        // Summary table
        const summaryTable = createTable(['Metric', 'Value']);
        summaryTable.push(
          ['Total Devices', String(report.summary.totalDevices)],
          ['Routers', String(report.summary.routers)],
          ['End Devices', String(report.summary.endDevices)],
          ['Critical Issues', report.summary.criticalIssues > 0 ? c.error(String(report.summary.criticalIssues)) : c.success('0')],
          ['Warnings', report.summary.warnings > 0 ? c.warn(String(report.summary.warnings)) : '0'],
        );
        console.log(summaryTable.toString());

        if (report.issues.length === 0) {
          console.log(c.success('\n✓ No issues detected!'));
        } else {
          // Critical issues
          const critical = report.issues.filter(i => i.severity === 'critical');
          if (critical.length > 0) {
            console.log(c.bold('\nCritical Issues'));
            const critTable = createTable(['Device', 'Issue']);
            for (const issue of critical) {
              critTable.push([c.error(issue.device), issue.message]);
            }
            console.log(critTable.toString());
          }

          // Warnings
          const warnings = report.issues.filter(i => i.severity === 'warning');
          if (warnings.length > 0) {
            console.log(c.bold('\nWarnings'));
            const warnTable = createTable(['Device', 'Issue']);
            for (const issue of warnings) {
              warnTable.push([c.warn(issue.device), issue.message]);
            }
            console.log(warnTable.toString());
          }
        }

        // Low LQI devices
        const lowLqi = report.devices.filter(d => d.lqi !== undefined && d.lqi < 50);
        if (lowLqi.length > 0) {
          console.log(c.bold('\nLow Signal Devices'));
          const lqiTable = createTable(['LQI', 'Device', 'Type']);
          for (const d of lowLqi.sort((a, b) => (a.lqi || 0) - (b.lqi || 0))) {
            lqiTable.push([formatLqi(d.lqi), d.name, d.type]);
          }
          console.log(lqiTable.toString());
        }

        // Low battery devices
        const lowBattery = report.devices.filter(d => d.battery !== undefined && d.battery < 25);
        if (lowBattery.length > 0) {
          console.log(c.bold('\nLow Battery Devices'));
          const batTable = createTable(['Battery', 'Device']);
          for (const d of lowBattery.sort((a, b) => (a.battery || 0) - (b.battery || 0))) {
            batTable.push([formatBattery(d.battery), d.name]);
          }
          console.log(batTable.toString());
        }

        console.log();
      }
    },
  },

  // Help
  'help': {
    description: 'Show help',
    action: async () => {
      showHelp();
    },
  },
};

function showHelp(): void {
  console.log(`
${c.bold('Zigbee2MQTT CLI')} - Command-line interface for Zigbee2MQTT

${c.bold('USAGE:')}
  z2m [options] <command> [arguments]

${c.bold('OPTIONS:')}
  -u, --url <url>      Zigbee2MQTT URL (default: $Z2M_URL or config file)
  -j, --json           Output raw JSON
  -h, --help           Show help

${c.bold('COMMANDS:')}
`);

  const categories: Record<string, string[]> = {
    'Connection': ['test'],
    'Config': ['config:show', 'config:set', 'config:path'],
    'Device': ['device:list', 'device:get', 'device:set', 'device:rename', 'device:remove', 'device:search', 'device:describe'],
    'Group': ['group:list', 'group:get', 'group:set'],
    'Bridge': ['bridge:info', 'bridge:state', 'bridge:restart', 'bridge:permitjoin', 'bridge:loglevel'],
    'Network': ['network:map', 'network:routes', 'network:routing-analysis', 'network:diagnose'],
    'Help': ['help'],
  };

  for (const [category, cmds] of Object.entries(categories)) {
    console.log(`  ${c.bold(category)}`);
    for (const cmd of cmds) {
      const command = commands[cmd];
      const usage = command.usage ? ` ${c.dim(command.usage)}` : '';
      console.log(`    ${c.info(cmd.padEnd(20))}${usage}`);
      console.log(`      ${c.dim(command.description)}`);
    }
    console.log();
  }

  console.log(`${c.bold('EXAMPLES:')}
  z2m test                                    Test connection
  z2m config:set wss://z2m.example.com/api    Save URL to config
  z2m device:list                             List all devices
  z2m device:list --type=Router               List only routers
  z2m device:list --routing                   List devices with parent router info
  z2m device:get "Kitchen Thermostat"         Get device details
  z2m device:get "Light" --routing            Get device with routing info
  z2m device:set "Light" '{"state":"ON"}'     Turn on a light
  z2m group:set "Living Room" '{"state":"ON"}' Turn on a group
  z2m network:diagnose                        Run network diagnostics
  z2m -j device:list                          Get devices as JSON

${c.bold('CONFIGURATION:')}
  Config file: ${c.dim(getConfigFilePath())}
  Priority: CLI options > Environment ($Z2M_URL) > Config file > Defaults
`);
}

// ============ Main ============

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      url: {
        type: 'string',
        short: 'u',
      },
      json: {
        type: 'boolean',
        short: 'j',
        default: false,
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
    strict: false,
    allowPositionals: true,
  });

  // Set global options
  globalUrl = values.url;
  outputJson = values.json ?? false;

  // Show help if requested or no command
  if (values.help) {
    showHelp();
    return;
  }

  // positionals[0] = bun, positionals[1] = script path, positionals[2+] = command & args
  const [command, ...commandArgs] = positionals.slice(2);

  // Reconstruct command-specific flags from values (parseArgs consumes unknown flags)
  const globalOptions = ['url', 'json', 'help'];
  for (const [key, val] of Object.entries(values)) {
    if (!globalOptions.includes(key)) {
      if (val === true) {
        commandArgs.push(`--${key}`);
      } else if (typeof val === 'string') {
        commandArgs.push(`--${key}=${val}`);
      }
    }
  }

  if (!command) {
    showHelp();
    return;
  }

  const cmd = commands[command];
  if (!cmd) {
    console.error(c.error(`Unknown command: ${command}`));
    console.error(`Run ${c.info('z2m help')} for available commands.`);
    process.exit(1);
  }

  try {
    await cmd.action(commandArgs);
  } catch (err) {
    error((err as Error).message);
  }
}

main();
