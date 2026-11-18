#!/bin/sh
# Healthcheck for the local broker. It also makes sure the application user exists.
#
# rabbitmq.conf loads definitions.json at boot. When it does, RabbitMQ skips creating its
# default user, so RABBITMQ_DEFAULT_USER/PASS would be ignored on a fresh volume. This script
# creates the user, or resets its password, from ATLAS_RABBITMQ_USER/PASSWORD. It is
# idempotent: once the credentials authenticate, it only checks connectivity. The password
# goes in on stdin, so it never shows up in the process list.
set -eu

user="${ATLAS_RABBITMQ_USER:?ATLAS_RABBITMQ_USER is not set}"
pass="${ATLAS_RABBITMQ_PASSWORD:?ATLAS_RABBITMQ_PASSWORD is not set}"

# Until the server has written its Erlang cookie, a CLI call (running as root here) would
# create the cookie itself with the wrong owner, and the broker would then fail to boot.
[ -s /var/lib/rabbitmq/.erlang.cookie ] || exit 1

rabbitmq-diagnostics -q check_port_connectivity >/dev/null

if printf '%s' "$pass" | rabbitmqctl -q authenticate_user "$user" >/dev/null 2>&1; then
  exit 0
fi

if rabbitmqctl -q list_users --no-table-headers | cut -f1 | grep -qxF "$user"; then
  printf '%s' "$pass" | rabbitmqctl -q change_password "$user"
else
  printf '%s' "$pass" | rabbitmqctl -q add_user "$user"
fi
rabbitmqctl -q set_user_tags "$user" administrator
rabbitmqctl -q set_permissions -p / "$user" '.*' '.*' '.*'

printf '%s' "$pass" | rabbitmqctl -q authenticate_user "$user" >/dev/null
