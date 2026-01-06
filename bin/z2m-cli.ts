#!/usr/bin/env bun
/**
 * Zigbee2MQTT CLI - A command-line interface for Zigbee2MQTT
 */

import { parseArgs } from 'util';
import { Z2MClient, type Z2MDevice, type DiagnosticIssue } from '../lib/api';
import pc from 'picocolors';

// Color aliases for semantic usage
const c = {
  error: pc.red,
  success: pc.green,
  warn: pc.yellow,
  info: pc.cyan,
  bold: pc.bold,
  dim: pc.dim,
};

// Global options
let globalUrl: string | undefined;
let outputJson = false;

function getClient(): Z2MClient {
  return new Z2MClient({
    url: globalUrl,
  });
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
  if (!lastSeen) return c.dim('unknown');
  const date = new Date(lastSeen);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 5) return c.success('just now');
  if (diffMins < 60) return c.success(`${diffMins}m ago`);
  if (diffHours < 24) return c.info(`${diffHours}h ago`);
  if (diffDays < 7) return c.warn(`${diffDays}d ago`);
  return c.error(`${diffDays}d ago`);
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
          console.log(`  Version: ${c.info(result.info?.version || 'unknown')}`);
          console.log(`  Channel: ${c.info(String(result.info?.network?.channel || 'unknown'))}`);
          console.log(`  Devices: Check with ${c.dim('z2m devices')}`);
        }
      } else {
        error(result.error || 'Connection failed');
      }
    },
  },

  // Device commands
  'devices': {
    description: 'List all devices',
    action: async () => {
      const client = getClient();
      const devices = await client.getDevices();
      const states = await client.collectDeviceStates(4000);

      if (outputJson) {
        output(devices.map(d => ({
          ...d,
          state: states[d.friendly_name] || null,
        })));
      } else {
        console.log(c.bold('\n📡 Zigbee Devices\n'));

        // Group by type
        const coordinator = devices.filter(d => d.type === 'Coordinator');
        const routers = devices.filter(d => d.type === 'Router' && !d.disabled);
        const endDevices = devices.filter(d => d.type === 'EndDevice' && !d.disabled);
        const disabled = devices.filter(d => d.disabled);

        console.log(`  Total: ${c.info(String(devices.length))} (${routers.length} routers, ${endDevices.length} end devices)\n`);

        if (coordinator.length > 0) {
          console.log(c.bold('  Coordinator:'));
          for (const d of coordinator) {
            console.log(`    ${c.info(d.friendly_name)}`);
          }
          console.log();
        }

        console.log(c.bold('  Routers:'));
        for (const d of routers) {
          const state = states[d.friendly_name];
          const lqi = formatLqi(state?.linkquality as number);
          const lastSeen = formatLastSeen(state?.last_seen as string);
          console.log(`    ${d.friendly_name.padEnd(35)} LQI: ${lqi.padEnd(12)} ${lastSeen}`);
        }
        console.log();

        console.log(c.bold('  End Devices:'));
        for (const d of endDevices) {
          const state = states[d.friendly_name];
          const lqi = formatLqi(state?.linkquality as number);
          const battery = state?.battery !== undefined ? formatBattery(state.battery as number) : '';
          const lastSeen = formatLastSeen(state?.last_seen as string);
          console.log(`    ${d.friendly_name.padEnd(35)} LQI: ${lqi.padEnd(12)} ${battery.padEnd(8)} ${lastSeen}`);
        }

        if (disabled.length > 0) {
          console.log();
          console.log(c.bold('  Disabled:'));
          for (const d of disabled) {
            console.log(`    ${c.dim(d.friendly_name)}`);
          }
        }
      }
    },
  },

  'device': {
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
        console.log(c.bold(`\n📱 ${d.friendly_name}\n`));
        console.log(`  IEEE Address:  ${c.info(d.ieee_address)}`);
        console.log(`  Type:          ${d.type}`);
        console.log(`  Model:         ${d.definition?.model || 'unknown'}`);
        console.log(`  Vendor:        ${d.definition?.vendor || 'unknown'}`);
        console.log(`  Power Source:  ${d.power_source || 'unknown'}`);
        console.log(`  Interview:     ${d.interview_completed ? c.success('completed') : c.error('incomplete')}`);
        console.log(`  Disabled:      ${d.disabled ? c.warn('yes') : 'no'}`);

        if (state) {
          console.log(c.bold('\n  State:'));
          const importantKeys = ['linkquality', 'battery', 'state', 'temperature', 'humidity', 'occupancy', 'contact', 'last_seen'];
          for (const key of importantKeys) {
            if (state[key] !== undefined) {
              let value = String(state[key]);
              if (key === 'linkquality') value = formatLqi(state[key] as number);
              if (key === 'battery') value = formatBattery(state[key] as number);
              if (key === 'last_seen') value = formatLastSeen(state[key] as string);
              console.log(`    ${key.padEnd(16)} ${value}`);
            }
          }
          // Show other keys
          const otherKeys = Object.keys(state).filter(k => !importantKeys.includes(k));
          if (otherKeys.length > 0) {
            console.log(c.dim(`\n  Other: ${otherKeys.join(', ')}`));
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

  'devices:search': {
    description: 'Search devices by name/model/vendor',
    usage: '<query>',
    action: async (args) => {
      if (!args[0]) error('Search query required');
      const client = getClient();
      const devices = await client.searchDevices(args[0]);
      if (outputJson) {
        output(devices);
      } else {
        console.log(c.bold(`\n🔍 Found ${devices.length} device(s) matching "${args[0]}":\n`));
        for (const d of devices) {
          console.log(`  ${c.info(d.friendly_name)}`);
          console.log(`    ${c.dim(`${d.definition?.vendor || ''} ${d.definition?.model || ''}`)}`.trim());
        }
      }
    },
  },

  'devices:routers': {
    description: 'List only router devices',
    action: async () => {
      const client = getClient();
      const devices = await client.findDevicesByType('Router');
      const states = await client.collectDeviceStates(4000);
      if (outputJson) {
        output(devices);
      } else {
        console.log(c.bold(`\n🔌 Routers (${devices.length}):\n`));
        for (const d of devices) {
          const state = states[d.friendly_name];
          const lqi = formatLqi(state?.linkquality as number);
          console.log(`  ${d.friendly_name.padEnd(35)} LQI: ${lqi}`);
        }
      }
    },
  },

  // Group commands
  'groups': {
    description: 'List all groups',
    action: async () => {
      const client = getClient();
      const groups = await client.getGroups();
      if (outputJson) {
        output(groups);
      } else {
        console.log(c.bold('\n👥 Groups:\n'));
        if (groups.length === 0) {
          console.log(c.dim('  No groups defined'));
        } else {
          for (const g of groups) {
            console.log(`  ${c.info(String(g.id).padStart(4))} ${g.friendly_name} (${g.members.length} members)`);
          }
        }
      }
    },
  },

  'group': {
    description: 'Get group details',
    usage: '<name-or-id>',
    action: async (args) => {
      if (!args[0]) error('Group name or ID required');
      const client = getClient();
      const group = await client.getGroup(args[0]);
      if (!group) error(`Group "${args[0]}" not found`);
      output(group);
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
        console.log(c.bold('\n🌉 Bridge Information\n'));
        console.log(`  Version:        ${c.info(info.version)}`);
        console.log(`  Commit:         ${c.dim(info.commit?.substring(0, 8) || 'unknown')}`);
        console.log(`  Coordinator:    ${info.coordinator?.type || 'unknown'}`);
        console.log(`  IEEE Address:   ${c.info(info.coordinator?.ieee_address || 'unknown')}`);
        console.log();
        console.log(c.bold('  Network:'));
        console.log(`    Channel:      ${c.info(String(info.network?.channel))}`);
        console.log(`    PAN ID:       ${info.network?.pan_id}`);
        console.log(`    Extended PAN: ${info.network?.extended_pan_id}`);
        console.log();
        console.log(`  Log Level:      ${info.log_level}`);
        console.log(`  Permit Join:    ${info.permit_join ? c.success('enabled') : 'disabled'}`);
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
      output(state);
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
    description: 'Get network map (raw)',
    action: async () => {
      const client = getClient();
      const map = await client.getNetworkMap();
      output(map);
    },
  },

  // Diagnostics
  'diagnose': {
    description: 'Run network diagnostics',
    action: async () => {
      const client = getClient();
      console.error(c.dim('Collecting device states (5s)...'));
      const report = await client.diagnose();

      if (outputJson) {
        output(report);
      } else {
        console.log(c.bold('\n🔍 Zigbee Network Diagnostic Report\n'));

        // Summary
        console.log(c.bold('Summary:'));
        console.log(`  Devices:    ${c.info(String(report.summary.totalDevices))} (${report.summary.routers} routers, ${report.summary.endDevices} end devices)`);
        console.log(`  Issues:     ${report.summary.criticalIssues > 0 ? c.error(String(report.summary.criticalIssues) + ' critical') : c.success('0 critical')}, ${report.summary.warnings > 0 ? c.warn(String(report.summary.warnings) + ' warnings') : '0 warnings'}`);

        if (report.issues.length === 0) {
          console.log(c.success('\n✓ No issues detected!\n'));
        } else {
          console.log(c.bold('\nIssues:\n'));

          // Critical issues first
          const critical = report.issues.filter(i => i.severity === 'critical');
          if (critical.length > 0) {
            console.log(c.error('  CRITICAL:'));
            for (const issue of critical) {
              console.log(`    ${c.error('●')} ${issue.device}: ${issue.message}`);
            }
            console.log();
          }

          // Warnings
          const warnings = report.issues.filter(i => i.severity === 'warning');
          if (warnings.length > 0) {
            console.log(c.warn('  WARNINGS:'));
            for (const issue of warnings) {
              console.log(`    ${c.warn('●')} ${issue.device}: ${issue.message}`);
            }
          }
        }

        // Low LQI devices table
        const lowLqi = report.devices.filter(d => d.lqi !== undefined && d.lqi < 50);
        if (lowLqi.length > 0) {
          console.log(c.bold('\nLow Signal Devices:'));
          for (const d of lowLqi.sort((a, b) => (a.lqi || 0) - (b.lqi || 0))) {
            console.log(`  ${formatLqi(d.lqi).padEnd(12)} ${d.name} (${d.type})`);
          }
        }

        // Low battery devices
        const lowBattery = report.devices.filter(d => d.battery !== undefined && d.battery < 25);
        if (lowBattery.length > 0) {
          console.log(c.bold('\nLow Battery Devices:'));
          for (const d of lowBattery.sort((a, b) => (a.battery || 0) - (b.battery || 0))) {
            console.log(`  ${formatBattery(d.battery).padEnd(8)} ${d.name}`);
          }
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
  z2m-cli [options] <command> [arguments]

${c.bold('OPTIONS:')}
  -u, --url <url>      Zigbee2MQTT URL (default: $Z2M_URL or ws://localhost:8080)
  -j, --json           Output raw JSON
  -h, --help           Show help

${c.bold('COMMANDS:')}
`);

  const categories: Record<string, string[]> = {
    'Connection': ['test'],
    'Devices': ['devices', 'device', 'device:set', 'device:rename', 'device:remove', 'devices:search', 'devices:routers'],
    'Groups': ['groups', 'group'],
    'Bridge': ['bridge:info', 'bridge:state', 'bridge:restart', 'bridge:permitjoin', 'bridge:loglevel'],
    'Network': ['network:map'],
    'Diagnostics': ['diagnose'],
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
  z2m test                                  Test connection
  z2m devices                               List all devices
  z2m device "Kitchen Thermostat"           Get device details
  z2m device:set "Light" '{"state":"ON"}'   Turn on a light
  z2m diagnose                              Run network diagnostics
  z2m -j devices                            Get devices as JSON
  z2m -u wss://z2m.example.com/api test     Connect to custom server

${c.bold('ENVIRONMENT VARIABLES:')}
  Z2M_URL     Default Zigbee2MQTT WebSocket URL (e.g., wss://z2m.example.com/api)
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
