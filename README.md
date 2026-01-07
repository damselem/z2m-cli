# z2m-cli

A command-line interface for [Zigbee2MQTT](https://www.zigbee2mqtt.io/) built with [Bun](https://bun.sh/).

## Features

- List and manage Zigbee devices with formatted table output
- View device states and send commands
- Set device descriptions with structured metadata (YAML format)
- Network diagnostics with automatic issue detection
- Routing table visualization (parent-child relationships)
- Bridge management (restart, permit join, log level)
- Group management
- XDG-compliant configuration file
- JSON output for scripting and automation

## Installation

```bash
# Clone or copy the project
cd z2m-cli

# Install dependencies
bun install

# Optional: Link globally
bun link
```

## Configuration

Configuration is stored at `~/.config/z2m-cli/config.json` following XDG conventions.

```bash
# Save your Z2M URL to config
z2m config:set wss://z2m.example.com/api

# View current configuration
z2m config:show

# Show config file path
z2m config:path
```

**Priority order** (highest to lowest):
1. CLI options (`-u, --url`)
2. Environment variables (`Z2M_URL`)
3. Config file
4. Default (`ws://localhost:8080`)

## Usage

```bash
# If configured via config file or Z2M_URL
z2m <command>

# Or specify URL directly
z2m -u wss://z2m.example.com/api <command>
```

### Options

| Option | Description |
|--------|-------------|
| `-u, --url <url>` | Zigbee2MQTT WebSocket URL |
| `-j, --json` | Output raw JSON |
| `-h, --help` | Show help |

## Commands

All commands follow the `resource:action` pattern for consistency.

### Connection & Configuration

```bash
z2m test                    # Test connection
z2m config:show             # Show current config
z2m config:set <url>        # Save URL to config
z2m config:path             # Show config file path
```

### Device

```bash
z2m device:list             # List all devices with LQI, battery, last seen
z2m device:list --type=Router  # List only router devices
z2m device:list --routing   # Include parent router info (slower)
z2m device:get <name>       # Get device info and current state
z2m device:get <name> --routing  # Include routing info
z2m device:set <name> <json>  # Send command to device
z2m device:rename <old> <new> # Rename a device
z2m device:remove <name>    # Remove device from network
z2m device:search <query>   # Search by name/model/vendor
z2m device:describe <name> <desc>  # Set device description
```

### Group

```bash
z2m group:list              # List all groups
z2m group:get <name-or-id>  # Get group details
z2m group:set <name> <json> # Send command to group
```

### Bridge

```bash
z2m bridge:info             # Bridge version, channel, coordinator info
z2m bridge:state            # Bridge runtime state
z2m bridge:restart          # Restart the bridge
z2m bridge:permitjoin on    # Enable pairing mode
z2m bridge:permitjoin off   # Disable pairing mode
z2m bridge:permitjoin on 60 # Enable for 60 seconds
z2m bridge:permitjoin on 120 --device="Router Name"  # Enable on specific router
z2m bridge:loglevel debug   # Set log level
```

### Network

```bash
z2m network:map             # Get network topology summary
z2m network:routes          # Show routing table (parent-child relationships)
z2m network:diagnose        # Run full network diagnostics
```

## Examples

### List all devices
```
$ z2m device:list

Devices (53)
13 routers, 37 end devices

Routers
   Name                         LQI    Model          Last Seen
   Living Room Light            207    LCT001         now
   Kitchen Plug                 156    SP600          2m

End Devices
   Name                         LQI    Battery   Model     Last Seen
   Bedroom Thermostat           83     100%      TRVZB     now
   Front Door Sensor            120    87%       SNZB-04   5m
```

### List devices with routing info
```
$ z2m device:list --routing

Devices (53)
13 routers, 37 end devices

Routers
   Name                  Parent                LQI    Model     Last Seen
   Living Room Light     Coordinator           207    LCT001    now
   Kitchen Plug          Living Room Light     156    SP600     2m

End Devices
   Name                  Parent                LQI    Battery   Model     Last Seen
   Bedroom Thermostat    Kitchen Plug          83     100%      TRVZB     now
   Front Door Sensor     Living Room Light     120    87%       SNZB-04   5m
```

### Get device details
```
$ z2m device:get "Kitchen Thermostat"

Kitchen Thermostat

   Property        Value
   IEEE Address    0x0cae5ffffeb0151b
   Type            EndDevice
   Model           TRVZB
   Vendor          SONOFF
   Power Source    Battery
   Interview       completed
   Disabled        no

State
   Property                     Value
   linkquality                  83
   battery                      49%
   running_state                idle
   occupied_heating_setpoint    21
```

Use `--routing` to see which router the device routes through:
```
$ z2m device:get "Kitchen Thermostat" --routing

Kitchen Thermostat

   Property        Value
   IEEE Address    0x0cae5ffffeb0151b
   Type            EndDevice
   Routes Through  Living Room Light
   Model           TRVZB
   ...
```

### Run diagnostics
```
$ z2m network:diagnose

Network Diagnostic Report

   Metric             Value
   Total Devices      53
   Routers            13
   End Devices        37
   Critical Issues    1
   Warnings           9

Critical Issues
   Device                  Issue
   Lego Room Thermostat    Critical battery level (14%)

Warnings
   Device                              Issue
   Basement Corridor Motion            Low battery level (21.5%)
   Office Thermostat                   Low battery level (24%)

Low Signal Devices
   LQI    Device                 Type
   40     Garden Back Light      Router
   47     Garage Side Motion     EndDevice

Low Battery Devices
   Battery    Device
   14%        Lego Room Thermostat
   17%        Corridor Ground Floor Climate
```

### Control a device
```bash
# Turn on a light
z2m device:set "Living Room Light" '{"state":"ON"}'

# Set brightness
z2m device:set "Living Room Light" '{"state":"ON","brightness":128}'

# Set thermostat temperature
z2m device:set "Bedroom Thermostat" '{"occupied_heating_setpoint":21}'
```

### Set device descriptions
```bash
# Set a simple description
z2m device:describe "Kitchen Thermostat" "Main kitchen radiator"

# Use YAML format for structured metadata
z2m device:describe "Kitchen Thermostat" $'floor: Ground Floor\nside: East'
```

### View routing table
```
$ z2m network:routes

Routing Table

Coordinator
Coordinator (Coordinator)
  ├─ Living Room Light (Router) LQI: 207
  ├─ Kitchen Plug (Router) LQI: 156

Routers
   Router                    Parent              LQI    Children
   Living Room Light         Coordinator         207    5
   Garden Light              Living Room Light   92     3

Device Routes
   Device                    Type        Routes Through        LQI
   Living Room Light         Router      Coordinator           207
   Bedroom Thermostat        EndDevice   Living Room Light     156
   Garden Sensor             EndDevice   Garden Light          89
```

### JSON output for scripting
```bash
# Get all devices as JSON
z2m -j device:list > devices.json

# Get diagnostic report as JSON
z2m -j network:diagnose | jq '.issues[] | select(.severity == "critical")'

# Extract low battery devices
z2m -j network:diagnose | jq '.devices | map(select(.battery < 25))'
```

## Diagnostic Thresholds

The `network:diagnose` command automatically flags issues based on these thresholds:

| Issue | Severity | Threshold |
|-------|----------|-----------|
| Interview incomplete | Critical | Device didn't complete Zigbee interview |
| LQI critical | Critical | < 30 |
| LQI low | Warning | < 50 |
| Battery critical | Critical | < 15% |
| Battery low | Warning | < 25% |
| Stale device | Warning | > 7 days (battery devices) |

## API Usage

The Z2MClient can be imported and used programmatically:

```typescript
import { Z2MClient } from 'z2m-cli';

const client = new Z2MClient({
  url: 'wss://z2m.example.com/api',
  timeout: 10000
});

// Get all devices
const devices = await client.getDevices();

// Get device state
const state = await client.getDeviceState('Kitchen Light');

// Send command
await client.setDeviceState('Kitchen Light', { state: 'ON' });

// Set device options (e.g., description)
await client.setDeviceOptions('Kitchen Light', { description: 'floor: Ground Floor' });

// Get network map with routing info
const networkMap = await client.getNetworkMap();

// Run diagnostics
const report = await client.diagnose();
console.log(report.summary);
console.log(report.issues);

// Collect all device states
const states = await client.collectDeviceStates(5000);
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `Z2M_URL` | Zigbee2MQTT WebSocket URL | `ws://localhost:8080` |
| `Z2M_TIMEOUT` | Request timeout in ms | `10000` |
| `XDG_CONFIG_HOME` | Config directory | `~/.config` |

## URL Format

The WebSocket URL should point to your Zigbee2MQTT instance:

- Local: `ws://localhost:8080` or `ws://192.168.1.100:8080`
- Remote with TLS: `wss://z2m.example.com/api`
- With explicit path: `ws://localhost:8080/api`

The client automatically:
- Appends `/api` if missing
- Converts `http://` to `ws://` and `https://` to `wss://`

## Building

```bash
# Compile to standalone binary
bun run build

# Output: ./z2m-cli (native executable)
```

## License

MIT
