# @beyondthecloud/sf-veles

SF CLI plugin for [Veles](https://beyondthecloud.dev/veles) — set up Veles on an existing scratch org or sandbox and connect it to your Veles Hub.

## Installation

```bash
sf plugins install @beyondthecloud/sf-veles
```

## Usage

> **Note:** This command does not create scratch orgs or sandboxes. The target org must already exist and be authorized with the Salesforce CLI before running `sf veles setup`. For sandboxes, an `Environment__c` record for that sandbox must also already exist on the Hub.

```bash
sf veles setup --target-org <scratch-or-sandbox> [--target-dev-hub <hub>] [--group <name>] [--installation-key <key>]
```

### What it does

1. Provisions the org on your Veles Hub (creates Environment record + connection token)
2. Installs the Veles managed package (if not already present)
3. Deploys Remote Site Settings for Hub communication
4. Configures the connection metadata
5. Connects the org to the Hub

### Examples

```bash
# Set up Veles on an existing scratch org (uses default DevHub)
sf veles setup --target-org my-scratch

# Set up Veles on an existing scratch org with explicit DevHub and group
sf veles setup --target-org my-scratch --target-dev-hub my-hub --group MyGroup

# Set up Veles on an existing sandbox with explicit Hub
sf veles setup --target-org my-sandbox --target-dev-hub my-hub

# With package installation key
sf veles setup --target-org my-scratch --installation-key MyKey123
```

### Flags

| Flag                 | Alias | Required | Description                                                     |
| -------------------- | ----- | -------- | --------------------------------------------------------------- |
| `--target-org`       | `-o`  | Yes      | Already-created and authorized scratch org or sandbox to set up |
| `--target-dev-hub`   | `-v`  | No       | Hub/DevHub org (defaults to SF CLI default)                     |
| `--group`            | `-g`  | No       | Environment group name on the Hub                               |
| `--installation-key` | `-k`  | No       | Installation key for the Veles package                          |

## Prerequisites

- **The target org must already be created and authorized via the Salesforce CLI.** This command does not create scratch orgs or sandboxes.
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) installed
- Veles managed package installed on your Hub org
- Authenticated to both the target org and Hub/DevHub
- For sandboxes: an `Environment__c` record for the sandbox must already exist on the Hub

## License

MIT
