# summary

Provision and connect a scratch org or sandbox to the Veles Hub.

# description

Provisions a scratch org or sandbox on the Hub by creating an Environment record and VelesConnection token, then deploys the connection metadata to the target org and initiates the connect flow. For scratch orgs, automatically installs the Veles package if not already present.

# examples

- Provision scratch org with default DevHub:

  <%= config.bin %> <%= command.id %> --target-org my-scratch

- Provision scratch org with explicit DevHub and group:

  <%= config.bin %> <%= command.id %> --target-org my-scratch --target-dev-hub my-hub --group MyGroup

- Provision sandbox with explicit Hub:

  <%= config.bin %> <%= command.id %> --target-org my-sandbox --target-dev-hub my-hub

- Provision scratch org with package installation key:

  <%= config.bin %> <%= command.id %> --target-org my-scratch --installation-key MyKey123

- Provision using SF CLI defaults (default org + default DevHub):

  <%= config.bin %> <%= command.id %>

# flags.target-org.summary

Scratch org or sandbox alias or username to provision (defaults to the SF CLI default org).

# flags.target-dev-hub.summary

Hub or DevHub org alias or username (defaults to the scratch org's DevHub or the SF CLI default DevHub).

# flags.group.summary

Environment group name on the Hub.

# flags.installation-key.summary

Installation key for the Veles package (if required).
