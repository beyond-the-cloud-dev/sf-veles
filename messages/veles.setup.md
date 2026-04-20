# summary

Set up Veles on an existing scratch org or sandbox and connect it to the Veles Hub.

# description

This command does not create scratch orgs or sandboxes. The target org must already exist and be authorized with the Salesforce CLI before running `sf veles setup`. For sandboxes, an `Environment__c` record for that sandbox must also already exist on the Hub.

Sets up Veles on an existing scratch org or sandbox by creating an Environment record and VelesConnection token on the Hub, then deploying the connection metadata to the target org and initiating the connect flow. For scratch orgs, automatically installs the Veles package if not already present.

# examples

- Set up Veles on scratch org with default DevHub:

  <%= config.bin %> <%= command.id %> --target-org my-scratch

- Set up Veles on scratch org with explicit DevHub and group:

  <%= config.bin %> <%= command.id %> --target-org my-scratch --target-dev-hub my-hub --group MyGroup

- Set up Veles on sandbox with explicit Hub:

  <%= config.bin %> <%= command.id %> --target-org my-sandbox --target-dev-hub my-hub

- Set up Veles on scratch org with package installation key:

  <%= config.bin %> <%= command.id %> --target-org my-scratch --installation-key MyKey123

- Set up Veles using SF CLI defaults (default org + default DevHub):

  <%= config.bin %> <%= command.id %>

# flags.target-org.summary

Already-created and authorized scratch org or sandbox (alias or username) to set up Veles on (defaults to the SF CLI default org).

# flags.target-dev-hub.summary

Hub or DevHub org alias or username (defaults to the scratch org's DevHub or the SF CLI default DevHub).

# flags.group.summary

Environment group name on the Hub.

# flags.installation-key.summary

Installation key for the Veles package (if required).
