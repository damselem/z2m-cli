# Claude Integration Guide for z2m-cli

This document explains how to use z2m-cli with Claude for Zigbee2MQTT network management and diagnostics.

## Quick Start

```bash
cd /Users/damselem/dev/z2m-cli
bun install
export Z2M_URL="wss://z2m.numeroo.app/api"

# Test connection
bun run bin/z2m-cli.ts test

# Run diagnostics
bun run bin/z2m-cli.ts -j diagnose
```

## CLI Commands

### Connection
- `z2m test` - Test connection to Z2M

### Devices
- `z2m devices` - List all devices with LQI, battery, last seen
- `z2m device <name>` - Get detailed device info and state
- `z2m device:set <name> <json>` - Send command to device
- `z2m device:rename <old> <new>` - Rename device
- `z2m device:remove <name> [--force]` - Remove device
- `z2m devices:search <query>` - Search by name/model/vendor
- `z2m devices:routers` - List only routers

### Groups
- `z2m groups` - List all groups
- `z2m group <name-or-id>` - Get group details

### Bridge
- `z2m bridge:info` - Bridge version, channel, coordinator info
- `z2m bridge:state` - Bridge state
- `z2m bridge:restart` - Restart bridge
- `z2m bridge:permitjoin <on|off> [time]` - Permit join
- `z2m bridge:loglevel <level>` - Set log level

### Network
- `z2m network:map` - Get raw network map

### Diagnostics
- `z2m diagnose` - Run full network diagnostics

## Using with Claude

### Get JSON Output
Always use `-j` flag when piping to Claude for analysis:

```bash
bun run bin/z2m-cli.ts -j diagnose
bun run bin/z2m-cli.ts -j devices
bun run bin/z2m-cli.ts -j device "Kitchen Thermostat"
```

### Diagnostic Report Structure

The `diagnose` command returns:

```typescript
{
  summary: {
    totalDevices: number,
    routers: number,
    endDevices: number,
    coordinator: number,
    disabled: number,
    criticalIssues: number,
    warnings: number
  },
  issues: [{
    device: string,
    type: 'interview_incomplete' | 'lqi_critical' | 'lqi_low' | 'battery_critical' | 'battery_low' | 'stale',
    severity: 'critical' | 'warning' | 'info',
    message: string,
    value?: any
  }],
  devices: [{
    name: string,
    ieee: string,
    type: 'Router' | 'EndDevice',
    lqi?: number,
    battery?: number,
    lastSeen?: string,
    model?: string
  }]
}
```

### Issue Types

| Type | Severity | Threshold | Description |
|------|----------|-----------|-------------|
| `interview_incomplete` | critical | - | Device didn't complete Zigbee interview |
| `lqi_critical` | critical | < 30 | Very weak signal, likely connection issues |
| `lqi_low` | warning | < 50 | Weak signal, may have intermittent issues |
| `battery_critical` | critical | < 15% | Battery needs immediate replacement |
| `battery_low` | warning | < 25% | Battery should be replaced soon |
| `stale` | warning | > 7 days | Battery device hasn't reported in a week |

### Common Tasks

#### 1. Network Health Check
```bash
bun run bin/z2m-cli.ts -j diagnose | jq '.summary'
```

#### 2. Find Problematic Devices
```bash
bun run bin/z2m-cli.ts -j diagnose | jq '.issues[] | select(.severity == "critical")'
```

#### 3. Get Device State
```bash
bun run bin/z2m-cli.ts -j device "Kitchen Thermostat" | jq '.state'
```

#### 4. Control Device
```bash
# Turn on a light
bun run bin/z2m-cli.ts device:set "Living Room Light" '{"state":"ON"}'

# Set thermostat
bun run bin/z2m-cli.ts device:set "Bedroom Thermostat" '{"occupied_heating_setpoint":21}'

# Trigger valve recalibration (SONOFF TRVZB)
bun run bin/z2m-cli.ts device:set "Thermostat" '{"valve_closing_degree":0}'
sleep 2
bun run bin/z2m-cli.ts device:set "Thermostat" '{"valve_closing_degree":100}'
```

#### 5. List Low Battery Devices
```bash
bun run bin/z2m-cli.ts -j diagnose | jq '.devices | map(select(.battery != null and .battery < 25)) | sort_by(.battery)'
```

#### 6. List Low LQI Devices
```bash
bun run bin/z2m-cli.ts -j diagnose | jq '.devices | map(select(.lqi != null and .lqi < 50)) | sort_by(.lqi)'
```

## API Client Usage

The Z2MClient class can be imported and used directly:

```typescript
import { Z2MClient } from './lib/api';

const client = new Z2MClient({ url: 'wss://z2m.numeroo.app/api' });

// Get all devices
const devices = await client.getDevices();

// Get device state
const state = await client.getDeviceState('Kitchen Thermostat');

// Send command
await client.setDeviceState('Light', { state: 'ON', brightness: 128 });

// Run diagnostics
const report = await client.diagnose();

// Collect all device states (5 seconds)
const states = await client.collectDeviceStates(5000);
```

## Environment Variables

- `Z2M_URL` - Zigbee2MQTT WebSocket URL (default: `ws://localhost:8080`)

## Troubleshooting

### Connection Timeout
Increase timeout if your network is slow:
```typescript
const client = new Z2MClient({ url: '...', timeout: 20000 });
```

### WebSocket URL Format
The URL should point to the Z2M WebSocket API:
- Local: `ws://localhost:8080/api` or `ws://localhost:8080`
- Remote: `wss://z2m.example.com/api`

The client automatically appends `/api` if missing and converts `http(s)` to `ws(s)`.
