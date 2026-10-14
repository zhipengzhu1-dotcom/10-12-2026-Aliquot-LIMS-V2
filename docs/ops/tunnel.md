# Tunnel and Access

The people who act as the Operator reach the Conductor at `https://agents.nitrolims-demo.com`. Each one signs in with their own email, and every act they take in the interface names that email in the Ledger (ADR-0019). This page says how that address is set up on the Operator's Cloudflare account, what it costs, how to check it, how to undo it, and how to add, remove or change a person's email.

A request takes this path:

1. Cloudflare Access, team `aliquot-pilot`, stops every request to `agents.nitrolims-demo.com` whose browser has not logged in through Access. It sends the browser to `https://aliquot-pilot.cloudflareaccess.com`, which mails a one-time PIN to an email the Access policy allows.
2. After the login, Cloudflare adds a signed `Cf-Access-Jwt-Assertion` header and sends the request down the Cloudflare Tunnel `aliquot`.
3. `cloudflared` on the Mac reads `tools/tunnel/config.yml` and passes the request to `http://127.0.0.1:8787`.
4. `aliquot serve` checks the header again: the signature, the application's `aud` tag, that the email is one of `operator_emails`, and the expiry (README.md, "Access"). Any other request gets 401. An action the request runs names that email. The Conductor listens on `127.0.0.1` only, so nothing outside the Mac reaches it except through the Tunnel.

## Account values

These values were read on 2026-10-13 with read-only commands (`cf zones list`, `cf zero-trust organization get`, `cf zero-trust identity-providers list`, `cloudflared tunnel list`).

| Value | Id |
|---|---|
| Account | `fc08575168eaa6079b4e7659764f1b1c` |
| Zone `nitrolims-demo.com` (plan Free Website) | `019c4fe577dfb3927725f44ef1bfba2e` |
| Access team domain | `aliquot-pilot.cloudflareaccess.com`, so `access_team` is `aliquot-pilot` |
| One-time PIN identity provider | `f5adbc88-08bc-4758-943c-0380f35d9f52` |

This setup leaves these resources alone: the tunnels `NitrosoLIMS-DEMO` and `aliquot-animated`, the DNS records for `app.` and `animated.nitrolims-demo.com`, the Access applications for `nitrolims-demo.com` and `nitrolims-demo.com/portal`, and their policies `Pilot staff` and `Client portal`.

## What this setup creates

| Resource | Name | Command that prints its id |
|---|---|---|
| Tunnel | `aliquot` | `cloudflared tunnel info aliquot` |
| Tunnel credentials | `~/.cloudflared/aliquot.json` | none; the file stays on the Mac and never enters the repository |
| Access policy | `Aliquot Operator` | `cf zero-trust access policies list \| jq '.[] \| select(.name == "Aliquot Operator") \| .id'` |
| Access application | `Aliquot Conductor` | `cf zero-trust access applications list \| jq '.[] \| select(.name == "Aliquot Conductor") \| {id, aud}'` |
| DNS record | `agents.nitrolims-demo.com`, a proxied CNAME to `<tunnel id>.cfargotunnel.com` | `cf dns records list -z 019c4fe577dfb3927725f44ef1bfba2e --name agents.nitrolims-demo.com \| jq '.[].id'` |
| Local settings | `.aliquot/serve.json` | none; git ignores it |

## Cost

Everything here is on Cloudflare's free tier, and none of it adds a charge.

- Cloudflare Tunnel is free on every plan. Neither the tunnel nor its traffic costs anything.
- Cloudflare Access is free for up to 50 seats on the Zero Trust Free plan (Cloudflare counts each person who logs in as a seat), which the account has (`Teams Free Base`, $0 a month). This setup admits each person in `operator_emails`, one seat each.
- The DNS record is free on the zone's Free Website plan.

On 2026-10-13, `cf accounts subscriptions get` listed `Teams Free Base` at $0 and `R2 Paid` at $0. The R2 subscription predates this setup, and this setup uses no R2. To confirm in the dashboard, open **Manage Account > Billing > Subscriptions**.

## Set up

The Operator runs these commands once, in the order below, from the repository root of the checkout that will run `tools/serve.sh`. Each part names its undo. Access goes in before the DNS record, so the hostname never answers without Access.

The `cf` CLI keeps its state in `.cloudflare/` in the directory it runs from. Git ignores that directory.

### 1. Write the local settings

`tools/serve.sh` reads `.aliquot/serve.json`. It holds the Access team, the application's `aud` tag and `operator_emails`, the list of people who may act as the Operator. `tools/serve.sh` passes each one to `aliquot serve` as an `--operator-email`. Git ignores `.aliquot/`, so no email enters the repository.

Use inboxes that receive mail, because Access mails the one-time PIN there. The `git config user.email` of this repository is a GitHub noreply address, which receives no mail.

```sh
mkdir -p .aliquot
jq --arg email "<the first person's inbox>" '.operator_emails = [$email]' \
  tools/tunnel/serve.example.json > .aliquot/serve.json
```

Undo: `rm .aliquot/serve.json`.

### 2. Create the tunnel

```sh
cloudflared tunnel create --credentials-file ~/.cloudflared/aliquot.json aliquot
cloudflared tunnel info aliquot
```

The first command prints the tunnel id and writes the credentials to `~/.cloudflared/aliquot.json`, the path `tools/tunnel/config.yml` names. Never commit or print that file.

Undo:

```sh
cloudflared tunnel delete aliquot
rm ~/.cloudflared/aliquot.json
```

`tunnel delete` refuses while a `cloudflared` is connected. Stop `tools/serve.sh` first.

### 3. Create the Access policy

```sh
policy_id="$(cf zero-trust access policies create --name "Aliquot Operator" --decision allow \
  --include "$(jq -c '[.operator_emails[] | {email: {email: .}}]' .aliquot/serve.json)" | jq -r .id)"
echo "$policy_id"
```

Undo, after the application of part 4 is gone: `cf zero-trust access policies delete <policy id> --force`.

### 4. Create the Access application

```sh
app="$(cf zero-trust access applications create --body "$(jq -nc --arg policy "$policy_id" '{
  name: "Aliquot Conductor",
  type: "self_hosted",
  domain: "agents.nitrolims-demo.com",
  allowed_idps: ["f5adbc88-08bc-4758-943c-0380f35d9f52"],
  auto_redirect_to_identity: true,
  session_duration: "24h",
  app_launcher_visible: false,
  policies: [{id: $policy, precedence: 1}]
}')")"
echo "$app" | jq '{id, aud, domain}'
jq --arg aud "$(echo "$app" | jq -r .aud)" '.access_aud = $aud' .aliquot/serve.json > .aliquot/serve.json.new \
  && mv .aliquot/serve.json.new .aliquot/serve.json
```

The application allows the one-time PIN provider only, and sends the browser straight to it. The last command writes the application's `aud` tag in `.aliquot/serve.json`, where `tools/serve.sh` reads it.

Undo: `cf zero-trust access applications delete <application id> --force`.

### 5. Route the hostname to the tunnel

```sh
cloudflared tunnel route dns aliquot agents.nitrolims-demo.com
```

This creates a proxied CNAME from `agents.nitrolims-demo.com` to `<tunnel id>.cfargotunnel.com`.

Undo:

```sh
cf dns records list -z 019c4fe577dfb3927725f44ef1bfba2e --name agents.nitrolims-demo.com | jq '.[] | {id, content}'
cf dns records delete -z 019c4fe577dfb3927725f44ef1bfba2e <dns record id> --force
```

## Run

```sh
tools/serve.sh
```

The script builds the interface (`pnpm -C conductor build`). It then starts `aliquot serve` on `127.0.0.1`, with the Scheduler on, and with the Access flags from `.aliquot/serve.json`, and `cloudflared tunnel --config tools/tunnel/config.yml run aliquot`. The Conductor's port comes from the tunnel's ingress rule in `tools/tunnel/config.yml`, 8787, so the two always agree.

- Ctrl-C, or SIGTERM to the script, sends one SIGTERM to each process and waits for both to exit. The Conductor closes the Ledger and releases the writer lock.
- When either process exits by itself, the script stops the other and exits 1.
- `--home <dir>` names the data directory. The default is `$ALIQUOT_HOME`, else `.aliquot/` at the repository root.
- `--no-tunnel` starts only the Conductor, still with the Access flags. Use it to test the script before the tunnel exists. Every request then gets 401, because only Access can sign one.
- `--no-schedule` serves without the Scheduler, for a quiet demo: no Turn starts, so a Message said in the Chat view gets no answer. Without it, the Scheduler starts Turns on the subscription login, and the Energy budget is the limit.

The script exits 2 without starting anything when `.aliquot/serve.json` is missing or a value is empty or still a `<placeholder>`.

## Check it

The Operator checks these after the setup, because they need the account resources:

1. `cloudflared tunnel info aliquot` shows the tunnel with no connection while `tools/serve.sh` is stopped.
2. With `tools/serve.sh` running, `cloudflared tunnel info aliquot` shows connections.
3. `curl -sI https://agents.nitrolims-demo.com/` answers `302` with a `location` on `aliquot-pilot.cloudflareaccess.com`, never the Conductor's page.
4. In a browser, `https://agents.nitrolims-demo.com/` asks for an email, mails a PIN to that inbox, and then shows the Access landing with that email in its Session panel.
5. `curl -s -o /dev/null -w '%{http_code}' -H 'Cf-Access-Jwt-Assertion: forged' http://127.0.0.1:8787/api/org` prints `401`.
6. Ctrl-C in the `tools/serve.sh` terminal stops both processes. `pgrep -fl 'tunnel/config.yml'` prints nothing, and `cloudflared tunnel info aliquot` shows no connection.

## Undo everything

Stop `tools/serve.sh`, then remove the pieces in the reverse order of the setup:

```sh
cf dns records list -z 019c4fe577dfb3927725f44ef1bfba2e --name agents.nitrolims-demo.com | jq '.[] | {id, content}'
cf dns records delete -z 019c4fe577dfb3927725f44ef1bfba2e <dns record id> --force
cf zero-trust access applications delete <application id> --force
cf zero-trust access policies delete <policy id> --force
cloudflared tunnel delete aliquot
rm ~/.cloudflared/aliquot.json .aliquot/serve.json
```

## Add, remove or change a person's email

The emails live in two places, the Access policy `Aliquot Operator` and `operator_emails` in `.aliquot/serve.json`. Change both. To add a person, append their email; to remove one or change one, edit the list and then sign out every browser logged in under the old email.

```sh
jq --arg email "<the new inbox>" '.operator_emails += [$email]' .aliquot/serve.json > .aliquot/serve.json.new \
  && mv .aliquot/serve.json.new .aliquot/serve.json
cf zero-trust access policies update <policy id> --name "Aliquot Operator" --decision allow \
  --include "$(jq -c '[.operator_emails[] | {email: {email: .}}]' .aliquot/serve.json)"
cf zero-trust access applications revoke-tokens <application id>
```

`revoke-tokens` is needed only when an email left the list. Then restart `tools/serve.sh`, so `aliquot serve` admits the new list. Until the restart, the Conductor answers 401 to an added email, because the two places disagree. The Events an old email signed keep naming it.
