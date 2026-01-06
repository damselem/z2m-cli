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
    usage: '[--type=<Router|EndDevice>]',
    action: async (args) => {
      const client = getClient();
      let devices = await client.getDevices();
      const states = await client.collectDeviceStates(4000);

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
          const table = createTable(['Name', 'LQI', 'Model', 'Last Seen']);
          for (const d of routers) {
            const state = states[d.friendly_name];
            table.push([
              d.friendly_name,
              formatLqi(state?.linkquality as number),
              c.dim(d.definition?.model || '--'),
              formatLastSeen(state?.last_seen as string),
            ]);
          }
          console.log(table.toString());
          console.log();
        }

        // End devices table
        if (endDevices.length > 0) {
          console.log(c.bold('End Devices'));
          const table = createTable(['Name', 'LQI', 'Battery', 'Model', 'Last Seen']);
          for (const d of endDevices) {
            const state = states[d.friendly_name];
            table.push([
              d.friendly_name,
              formatLqi(state?.linkquality as number),
              formatBattery(state?.battery as number),
              c.dim(d.definition?.model || '--'),
              formatLastSeen(state?.last_seen as string),
            ]);
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
    usage: '<name>',
    action: async (args) => {
      if (!args[0]) error('Device name required');
      const client = getClient();
      const device = await client.getDevice(args[0]);
      if (!device) error(`Device "${args[0]}" not found`);

      const state = await client.getDeviceState(args[0]);

      if (outputJson) {
        output({ device, state });
      } else {
        const d = device!;
        console.log(c.bold(`\n${d.friendly_name}\n`));

        const infoTable = createTable(['Property', 'Value']);
        infoTable.push(
          ['IEEE Address', c.info(d.ieee_address)],
          ['Type', d.type],
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
    description: 'Enable/disable permit join',
    usage: '<on|off> [time]',
    action: async (args) => {
      if (!args[0]) error('Specify on or off');
      const permit = args[0].toLowerCase() === 'on' || args[0] === 'true';
      const time = args[1] ? parseInt(args[1]) : undefined;
      const client = getClient();
      await client.permitJoin(permit, time);
      output(outputJson ? { success: true, permit_join: permit } : c.success(`Permit join: ${permit ? 'enabled' : 'disabled'}${time ? ` for ${time}s` : ''}`));
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
      const map = await client.getNetworkMap() as { nodes?: Array<{ ieeeAddr: string; friendlyName: string; type: string; networkAddress: number; failed?: string[] }>; links?: Array<{ source: { ieeeAddr: string }; target: { ieeeAddr: string }; lqi: number; depth: number }> };
      if (outputJson) {
        output(map);
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
    'Device': ['device:list', 'device:get', 'device:set', 'device:rename', 'device:remove', 'device:search'],
    'Group': ['group:list', 'group:get', 'group:set'],
    'Bridge': ['bridge:info', 'bridge:state', 'bridge:restart', 'bridge:permitjoin', 'bridge:loglevel'],
    'Network': ['network:map', 'network:diagnose'],
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
  z2m device:get "Kitchen Thermostat"         Get device details
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
