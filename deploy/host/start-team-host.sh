#!/bin/sh
set -eu

node /opt/dsh/deploy/host/ensure-installed-team-plugin.mjs
node /opt/dsh/deploy/host/wait-for-credential-broker.mjs
exec dsh --profile web --patch /etc/dsh/team-host.patch.yml --host 127.0.0.1 --port 3081
