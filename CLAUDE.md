# CLAUDE.md - Project Context for Claude Code

## Project Overview

This is a CLI tool for interacting with Zigbee2MQTT instances via the WebSocket API. It's built with Bun (not Node.js) and TypeScript.

## Tech Stack

- **Runtime**: Bun (use `bun` commands, not `npm` or `node`)
- **Language**: TypeScript
- **Colors**: picocolors (not chalk or manual ANSI codes)
- **Tables**: cli-table3 for formatted output
- **CLI Parsing**: `Bun.argv` with Node's `util.parseArgs`
- **WebSocket**: Bun's native WebSocket (no external libraries)

## Project Structure

```
z2m-cli/
├── bin/
│   └── z2m-cli.ts    # CLI entry point
├── lib/
│   ├── api.ts        # Z2M WebSocket API client
│   └── config.ts     # XDG-compliant configuration
├── package.json
├── CLAUDE.md
├── README.md
└── bun.lock
```

## Key Commands

```bash
# Run CLI during development
bun run bin/z2m-cli.ts <command>

# Run with watch mode
bun --watch run bin/z2m-cli.ts <command>

# Build standalone executable
bun build bin/z2m-cli.ts --compile --outfile z2m-cli

# Install globally for local development
bun link
```

## Configuration

Config is stored at `~/.config/z2m-cli/config.json` (XDG-compliant).

Priority (highest to lowest):
1. CLI options (`-u`)
2. Environment variables (`Z2M_URL`)
3. Config file
4. Defaults (`ws://localhost:8080`)

### Config Commands
```bash
z2m config              # Show current configuration
z2m config:set <url>    # Save URL to config file
z2m config:path         # Show config file path
```

## Environment Variables

- `Z2M_URL` - Zigbee2MQTT WebSocket URL (default: ws://localhost:8080)
- `Z2M_TIMEOUT` - Request timeout in ms (default: 10000)
- `XDG_CONFIG_HOME` - Config directory (default: ~/.config)

## Code Conventions

- Use `picocolors` for terminal colors via the `pc` import
- Semantic color aliases are defined in `bin/z2m-cli.ts`:
  - `c.error` - red (for errors, critical LQI < 30, battery < 15%)
  - `c.success` - green (for success, good LQI, battery > 25%)
  - `c.warn` - yellow (for warnings, low LQI < 50, battery < 25%)
  - `c.info` - cyan (for informational highlights)
  - `c.bold` - bold (for headers)
  - `c.dim` - dim (for secondary info)
- Use `cli-table3` via `createTable()` helper for tabular output
- All API calls go through the `Z2MClient` class in `lib/api.ts`
- Use TypeScript types from the API module

## Z2M WebSocket API Notes

- Connect to `wss://host/api` or `ws://host:8080/api`
- Messages are JSON: `{ topic: "...", payload: {...} }`
- Device states are published with device name as topic
- Bridge commands use `bridge/request/*` topics
- Responses come on `bridge/response/*` or `bridge/*` topics

## CLI Commands Reference

### Connection & Config
```bash
z2m test                    # Test connection
z2m config                  # Show config
z2m config:set <url>        # Save URL
```

### Devices
```bash
z2m devices                 # List all devices (table format)
z2m device <name>           # Get device info and state
z2m device:set <n> <json>   # Send command to device
z2m device:rename <o> <n>   # Rename device
z2m device:remove <name>    # Remove from network
z2m devices:search <q>      # Search by name/model
z2m devices:routers         # List only routers
```

### Bridge & Network
```bash
z2m bridge:info             # Bridge info (version, channel, etc.)
z2m bridge:restart          # Restart bridge
z2m bridge:permitjoin on    # Enable pairing
z2m network:map             # Get network map (raw JSON)
```

### Diagnostics
```bash
z2m diagnose                # Full network health check
z2m -j diagnose             # JSON output for scripting
```

## Using with Claude

### Always Use JSON for Analysis
```bash
bun run bin/z2m-cli.ts -j diagnose
bun run bin/z2m-cli.ts -j devices
bun run bin/z2m-cli.ts -j device "Kitchen Thermostat"
```

### Diagnostic Report Structure
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

### Diagnostic Thresholds

| Type | Severity | Threshold |
|------|----------|-----------|
| `interview_incomplete` | critical | Device didn't complete Zigbee interview |
| `lqi_critical` | critical | < 30 |
| `lqi_low` | warning | < 50 |
| `battery_critical` | critical | < 15% |
| `battery_low` | warning | < 25% |
| `stale` | warning | > 7 days (battery devices) |

### Common Tasks

#### Device Control
```bash
# Turn on a light
z2m device:set "Living Room Light" '{"state":"ON"}'

# Set thermostat
z2m device:set "Bedroom Thermostat" '{"occupied_heating_setpoint":21}'

# SONOFF TRVZB valve recalibration
z2m device:set "Thermostat" '{"valve_closing_degree":0}'
sleep 2
z2m device:set "Thermostat" '{"valve_closing_degree":100}'
```

#### Filtering with jq
```bash
# Critical issues only
z2m -j diagnose | jq '.issues[] | select(.severity == "critical")'

# Low battery devices
z2m -j diagnose | jq '.devices | map(select(.battery != null and .battery < 25))'

# Low LQI devices
z2m -j diagnose | jq '.devices | map(select(.lqi != null and .lqi < 50)) | sort_by(.lqi)'
```

## Version Control

This project uses Jujutsu (jj) for version control with a Git remote at:
`git@github.com:damselem/z2m-cli.git`
