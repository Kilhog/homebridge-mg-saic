# homebridge-mg-saic

[![npm version](https://img.shields.io/npm/v/homebridge-mg-saic.svg)](https://www.npmjs.com/package/homebridge-mg-saic)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-mg-saic.svg)](https://www.npmjs.com/package/homebridge-mg-saic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

HomeKit control of a single MG EV (built and tested against an MG4) via the SAIC iSmart cloud API.

This is an unofficial, reverse-engineered integration. It isn't affiliated with, endorsed by, or supported by SAIC Motor or MG. It talks to the same undocumented cloud API used by the iSmart phone app, which can change or break without notice. Use it at your own risk, and see [`docs/API.md`](docs/API.md) for the full reverse-engineered API reference this plugin is built on.

SAIC allows only one active session per account, so logging in from this plugin will sign the iSmart phone app out. That's expected behaviour, not a bug.

## Current scope

Exposes one MG EV as one HomeKit accessory with:

- **Battery** — state of charge, charging state, low battery warning
- **LockMechanism** — central locking, lock and unlock, writable
- **ContactSensor** × 6 — driver door, passenger door, rear left door, rear right door, boot, bonnet
- **HeaterCooler** — cabin pre-conditioning, i.e. remote climate / aircon, as a **Cabin Heat** tile, plus a separate **Cabin Cool** tile only with `enableExperimentalCabinCool` (the compressor command is confirmed to heat the cabin instead of cooling it, so without that option the Cool tile is not shown). Each has its own target temperature slider (1 °C step): 17 °C to 33 °C on an MG4, otherwise chosen from the vehicle series (see below). Heat is confirmed working since 0.9.4. See below for details
- **Outlet** — charging cable plugged in (`On`) and actively drawing (`InUse`). Read-only: there's no charging command behind it, so a tap in the Home app is refused and the tile stays on the real state
- **TemperatureSensor** × 2 — interior and exterior temperature. Falls back to the last known good reading and flags `StatusFault` if the API returns an unavailable-field sentinel instead of a real value
- **Switch** × 2 — heated seats, left and right (off by default, see below)
- **Switch** × 2 — rear heated seats, rear left and rear right (off by default, MG S6 EV control from the reference client, not yet confirmed against real hardware, see below)
- **Switch** — rear window defrost (off by default, see below)
- **Switch** — front window defrost (off by default, not yet confirmed against real hardware, see below)
- **Switch** — heated steering wheel (off by default, MG S6 EV control from the reference client, not yet confirmed against real hardware, see below)
- **Switch** — window ventilation, all four door windows (off by default, MG S6 EV command format, see below)
- **GarageDoorOpener** — power tailgate, open and close (off by default, MG S6 EV control from the reference client, not yet confirmed against real hardware, see below)

Deliberately left out: tyre pressures, odometer, trip data, per-window open/close. Tyre pressure, odometer and trip data have no sensible HomeKit home. Per-window open/close was tried on an MG4 and does not work, see below; the MG S6 EV's all-windows ventilation command is a separate, optional switch.

**Lock/unlock, heated seats, and rear defrost have all been confirmed working against real hardware.** The request format (`POST /vehicle/control` with an `rvcReqType`/`rvcParams` body) is ported from the reference `saic-python-client-ng` client. Unlocking has been confirmed to actually open the doors, seat heat and rear defrost have both been confirmed to physically engage, all on a real MG4 running **software version SWi165 - R11 (Australia)**.

**Cabin pre-conditioning — the remote aircon — is two HeaterCooler services**, via `/vehicle/control` with `rvcReqType: "6"`, ported from the reference client's `start_ac`/`stop_ac`. **Starting Cabin Heat is confirmed working** against the same MG4 (SWi165 - R11, Australia) and physically ran the climate system.

Since the car has only one underlying climate system, the two tiles are mutually exclusive: turning one's `Active` on immediately shows the other as off in the Home app, rather than waiting for the next poll.

**Cabin Heat** — PTC resistive heater, no compressor:
- **Active** — turns it on/off
- **Temperature slider** — 1 °C step, range from the vehicle series (below). Sliding while active re-sends the command immediately so the car adjusts without toggling off and back on. The chosen temperature persists across on/off cycles for the session

**Slider range by vehicle series.** The temperature index sent to the car is always `°C − 14` (the same formula in `mg-saic-ha`'s MG4 profile and in `saic-python-mqtt-gateway` for every series), but the range a car accepts differs. The range is picked from the `series` code returned by `/vehicle/list`, the way `saic-python-mqtt-gateway` does: MG4 (`EH32…`) keeps 17–33 °C (the gateway caps it at 31 °C, this plugin keeps its long-standing 33 so nothing changes for MG4 owners), MG S5 (`MZS3E…`) gets 16–31 °C, and any other series gets the gateway's default 16–28 °C. The MG S6 EV (series `MIS3E…`) lands on 16–28 °C; its real range isn't confirmed anywhere. If the series can't be read at startup, it stays at 17–33 °C. The startup log prints the range in use, and `climateMinTemperature` / `climateMaxTemperature` (whole numbers, 16–33 °C) override it.

**Cabin Cool** — added in 0.9.7 sending param ID 22 = 1 (AC compressor on) as the same command as Cabin Heat. **Confirmed NOT to work**: tested against a real MG4 via HomeKit, it ran the heater at maximum instead of cooling, both by the iSmart app's own display and by feel. Without `enableExperimentalCabinCool` the Cool tile isn't shown at all, so that command is never sent (until 0.9.10-s6.3 the tile was shown and turning it on failed immediately). See `TESTING.md`/`docs/API.md` for what's been ruled out so far. If you can capture a real cooling command's raw request (from the iSmart app or from `mg-saic-ha`), an issue or PR is very welcome.

**Experimental Cabin Cool (`enableExperimentalCabinCool`, off by default, NOT confirmed on any real car).** The reference client's own `start_ac` never sends param 22 at all: it sends fan speed 2 and a target temperature index, and leaves it to the car to heat or cool towards that target (of its convenience commands, only front defrost sends 22 = 1). With this option on, turning Cabin Cool on sends exactly that — byte for byte the Cabin Heat command, with the Cool tile's own target temperature — on the hypothesis that the car cools when the target is below the cabin temperature. Cabin Heat's own behaviour doesn't change. Because the car may report this as `remoteClimateStatus` 2 (what `saic-python-mqtt-gateway` decodes as plain "on") rather than 3, the plugin remembers it was the Cool tile that asked and keeps showing Cool, not Heat, until the climate stops or another climate command is sent (this memory doesn't survive a Homebridge restart). While the option is on, every change in the raw `remoteClimateStatus` is logged, which is the quickest way to see what the car actually did. Stay near the car the first time you try it.

Each tile shows a plain on/off mode in the Home app (no mode-switch icon, unlike a single combined tile) — that's deliberate, so each side is independently addressable by Siri ("turn on Cabin Heat") and by HomeKit Automations (e.g. a scheduled switch for a cold morning vs. a hot afternoon).

One thing worth knowing:

- **This is not the "pre-drive" feature** in the newer iSmart phone apps. That's a different thing and nobody has reverse-engineered it — neither the reference client nor the Home Assistant integration implements it.

Stopping either tile has not been exercised yet against real hardware.

It's also the one control that's easy to overlook: it's governed by `enablePreconditioning` in config, and if that's off you get no tile in the Home app at all. Since 0.9.3 the startup log lists which services were exposed and which were left out, so you can check at a glance.

**Front window defrost is a separate Switch (`enableFrontDefrost`, off by default, not yet confirmed against real hardware)** — added in 0.9.9. Unlike rear defrost it has no dedicated status field on the car: turning it on sends the same climate command as Cabin Heat/Cool but with fan speed 5 instead of 2 (the exact combination confirmed correct by `mg-saic-client`'s own `start_front_defrost`, ported from decrypted iSmart traffic), fixed at 22 °C, and mirrors Active=INACTIVE onto both Cabin Heat and Cabin Cool since all three share the one climate system. Turning it off sends the general stop-climate command. Its On/Off state in HomeKit only reflects what was last commanded, not a value read back from the car, and won't survive a Homebridge restart — reasonable given the car auto-cancels defrost on its own after roughly 10 minutes. If you test it against real hardware, an issue or PR reporting the result is very welcome.

**Heated steering wheel is a separate Switch (`enableHeatedSteeringWheel`, off by default, not yet confirmed against real hardware by this plugin)** — for cars that have one, such as the MG S6 EV. Ported from the reference client's `control_heated_steering_wheel`: `rvcReqType "8"` with param 24 = 1 (on) or 0 (off). The switch reads its state back from `steeringHeatLevel` in the vehicle status, and a non-zero `steeringWheelHeatFailureReason` is logged as a warning (its values aren't documented anywhere, so the raw number is logged). The car switches the heater off by itself after about 10 minutes, so the tile can stay On in the Home app until the next poll catches up.

**Rear heated seats are two more Switches (`enableRearHeatedSeats`, off by default, not yet confirmed against real hardware by this plugin)** — for cars that have them, such as the MG S6 EV. They use the reference client's per-seat `control_heated_seat`: `rvcReqType "5"` with a single param (25 rear left, 26 rear right), so changing one rear seat never restates the other. Rear seats are on/off only; On sends 3, what the iSmart app sends. State is read from `secondRowLeftSeatHeatLevel` / `secondRowRightSeatHeatLevel`.

The front seats keep the two-seat command confirmed on an MG4. **`frontSeatHeatLevel`** (1, 2 or 3, default 3) picks the level a front switch's On sends; 3 is what every version before this option sent. Because both front seats go in one request, a front seat that's already on is restated at this level too.

**Power tailgate is a GarageDoorOpener (`enablePowerTailgate`, off by default, not yet confirmed against real hardware by this plugin)** — for cars with a power tailgate, such as the MG S6 EV. Ported from the reference client's `control_tailgate`, taken there from decrypted MG S6 EV app traffic (UK): `rvcReqType "9"` with a single param, 31 = 1 to open or 2 to close, and no param 255 terminator. It's deliberately not a Switch: HomeKit treats a garage door opener as a secure accessory, so Siri and automations ask for confirmation (or an unlocked phone) before moving it, the same way they do for the lock. Open/Closed is read from `bootStatus`, so it also shows Open when the boot was opened by hand; while a command is in flight the tile shows Opening/Closing. Cars without a power tailgate are expected to refuse the command. This is separate from the existing latch-release request (`openTailgate`, an unlock of lock 2), which is unchanged and still not exposed.

**Window open/close was tried and does not work.** Same request shape as the reference client, byte-verified, but the car consistently rejects it with `code 8`, `"Request failed. Please check the vehicle status and try again."`, whether the car was locked, unlocked with the driver's door held open, or freshly started, all tried against the same MG4 (SWi165 - R11, Australia). There's no config option or switch for it; the low-level `controlWindow`/`WINDOW_ID` request is still in `src/saic-client.js` for reference, unused, in case a firmware update or a different vehicle ever behaves differently. See `CHANGELOG.md`.

**Window ventilation is a separate Switch (`enableWindowVentilation`, off by default)** — the MG S6 EV's own window command, not the MG4-era one above. Ported from the reference client's `control_door_windows`: `rvcReqType "3"` with the sunroof param set to 0 (left alone), all four door windows set to 1, then the action in param 13 (0 close, 1 ventilate, 2 fully open), and no param 255 terminator. **The command format is confirmed on a real MG S6 EV** (Europe, left-hand drive, November 2026): the full-open form was accepted in about 10 seconds and all four window fields then read open. Turning the switch on sends *ventilate* (every door window opens a few centimetres), turning it off sends *close*; those two actions are not yet confirmed on the car, and fully opening the windows is deliberately not exposed. The car reports a ventilated window and a fully open one the same way, so the switch reads On whenever any door window is open, including one opened by hand, and turning it Off closes all four. Per the reference client the S6 doesn't accept single-window control this way. This is not expected to work on an MG4.

Built for a single-vehicle account. If your account has more than one vehicle, set the `vin` config option to pin the plugin to a specific one, see Configuration below.

## Installation

Published on npm. Install through Homebridge's Config UI X (search "MG SAIC" or "homebridge-mg-saic" under Plugins), or from the command line inside your Homebridge instance:

```bash
npm install -g homebridge-mg-saic
```

(drop `-g` and run it from your Homebridge storage directory instead if you're managing plugins locally rather than globally, e.g. inside a Docker-based Homebridge install).

## Configuration

Via Homebridge Config UI X (the plugin ships a `config.schema.json`, which drives the settings form there), or directly in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MgSaic",
      "name": "MG SAIC",
      "username": "you@example.com",
      "region": "Australia",
      "pollIntervalMinutes": 15,
      "enablePreconditioning": true,
      "enableDoorSensors": true,
      "enableTemperatureSensors": true,
      "enableHeatedSeats": false,
      "frontSeatHeatLevel": 3,
      "enableRearHeatedSeats": false,
      "enableRearDefrost": false,
      "enableFrontDefrost": false,
      "enableHeatedSteeringWheel": false,
      "enableWindowVentilation": false,
      "enablePowerTailgate": false
    }
  ]
}
```

Leave `password` out of `config.json` and instead set the `MG_SAIC_PASSWORD` environment variable for the Homebridge process, so the password isn't sitting in plain text on disk. If you do set `password` in config, be aware `config.json` is unencrypted.

Optional `climateMinTemperature` / `climateMaxTemperature` fields override the Cabin Heat / Cabin Cool slider range, which otherwise follows the vehicle series (see above).

On a Docker install (e.g. Homebridge on a NAS), the container's environment can't be changed without recreating it, and `config.json` is often readable by every user of the host. Use `passwordFile` instead: the path of a file that holds only the password, owned by the user Homebridge runs as and readable by it alone. From the Homebridge UI terminal (root in the official image), for example:

```bash
( umask 077 && read -rs -p 'iSmart password: ' P && printf '%s\n' "$P" > /homebridge/.mg-saic-password ); echo
```

then set `"passwordFile": "/homebridge/.mg-saic-password"`. The password is read once at startup; only trailing line breaks are stripped. The precedence is `password`, then `passwordFile`, then `MG_SAIC_PASSWORD`. A `passwordFile` that is set but missing, unreadable or empty stops the platform with an error rather than falling back to the environment, and a file readable by other users is flagged in the log. The startup log says which source was used, never the password.

Optional `accessoryName` field names the car accessory when it is first created; by default it takes the model name the account reports (e.g. `MG4 EV`, `MGS6 EV`), which is also shown as the accessory's model. An accessory restored from the Homebridge cache keeps its existing name, rename it in the Home app instead.

Optional `language` field (`"en"`, the default, or `"fr"`) sets the names the tiles get in the Home app: *Cabin Heat* / *Chauffage habitacle*, *Driver door* / *Porte conducteur*, *Charging cable* / *Câble de charge*... Each tile gets both `Name` and `ConfiguredName`: since iOS 16 the Home app shows the controls of a multi-service accessory by `ConfiguredName` and, without it, falls back to the bare type ("Switch 2", "Heater-Cooler", "Outlet"). A tile renamed in the Home app keeps that name; changing `language` renames only the tiles nobody renamed. Tiles are matched by their subtype, not their name, so renaming keeps rooms, scenes and automations. A tile whose option is turned off in config is removed from HomeKit at the next start (until now it stayed there, dead).

Optional `commandDelaySeconds` field (0 to 10, default 2) sets how commands from the Home app are sent. The car takes 10 to 25 s to confirm a command, while Homebridge gives a write about 9 s before telling the Home app "No Response" — which then sent the write again, or got tapped again: one accidental tap on the heated steering wheel once became 4 "on" and 2 "off" commands in 50 s. So every write (switches, Cabin Heat and its dial, lock, tailgate) is now answered at once, and the car gets the latest value once nothing more has changed for `commandDelaySeconds`. A burst that ends where it started — on then off again within the delay — sends nothing. A single change is always sent, even if the car already seems to be in that state, since that state can be one poll old. Each control has one command on its way at a time; changes made meanwhile are sent once it's done. Both front seats share one request, and turning Cabin Heat on then moving its dial sends a single start at the final temperature. If a command fails, the tile goes back to the car's state and the failure is in the Homebridge log (the Home app no longer shows "No Response" for it). `0` sends right away, still without making the Home app wait.

Optional `vin` field pins the plugin to a specific vehicle if the account ever returns more than one; otherwise it uses the first vehicle the account returns.

## Polling

Defaults to 15 minutes. SAIC's gateway has been observed pausing an account for around 15 minutes after it sees a login from another device, so polling too aggressively risks kicking your phone app's own session repeatedly. See `docs/API.md` for more on rate limiting.

Locking the car while the charger isn't already known to be plugged in fires a short burst of extra charging-status checks over the following 25 minutes, so a plug-in right after arriving home is picked up quickly rather than waiting out the full poll interval. See `CHANGELOG.md` (0.9.10) for details.

### Network failures and outages

The gateway or the network sometimes drops out for a minute or more (a real case: logins failing with `fetch failed` / `UND_ERR_CONNECT_TIMEOUT` on one gateway address, fine again a minute later). The plugin is built to ride that out without making things worse:

- **Every request has a 20 s timeout**, and network errors, timeouts and HTTP 5xx/429 are treated as transient. Login, the vehicle list and the first request of a status or charging poll are retried up to 4 times with exponential backoff and jitter.
- **A command is never sent twice.** While waiting on the car, a network error just means asking again about the same event id. The command itself is only re-sent when the error proves it never left (connect timeout, refused connection, DNS failure). Otherwise it fails with an "outcome unknown" message: the Home app shows the write failed, nothing is updated optimistically, the lock shows Unknown, and the car's real state is re-read 30 seconds later.
- **An expired session is renewed once, mid-request.** Requests logged out together share a single login, and a login the gateway refuses holds further logins off for 1, 2, 4, 8 then 15 minutes, since SAIC allows one session per account and has paused accounts that log in too often.
- **Polls never overlap**, and after consecutive failed polls the interval doubles, up to 4× the configured interval (15 → 30 → 60 min), back to normal on the first success. An outage is logged once as a warning, then at debug level, then one `SAIC API reachable again after N failed attempt(s) / X min` line.
- **HomeKit keeps the last values** while the API is unreachable. Once the last good status read is older than three poll intervals, the door and temperature sensors show a fault, so stale data doesn't pass for current.

### Not waking the car on every poll (`useStatusCache`, experimental)

Each routine poll reads `/vehicle/status`, which wakes the car — every 15 minutes by default, which is a concern for the 12 V battery. `useStatusCache` (off by default, **not yet tried on a real car**) makes routine polls read `/vehicle/status/cache` instead: the last status SAIC stored, read without waking the car. The full status is still read on the first poll, after any command, for the post-command re-read and the lock-triggered sequence, and whenever the cached reply lacks a field an enabled service needs. In the only capture available (from the reference client) the cache has no door or temperature fields, so with door or temperature sensors enabled it falls back to the full status on every poll; the log names the missing fields once. It only saves wake-ups with those sensors off.

## Testing

See [`TESTING.md`](TESTING.md) for a staged approach: verify the API client stand-alone, then run a throwaway test Homebridge instance before touching your real one, then a dedicated section on testing lock/unlock safely.

## Status

Running in production against a real MG4 (software version SWi165 - R11, Australia): battery, lock state, doors, boot, bonnet, and charging all confirmed reading correctly; lock/unlock, heated seats, and rear defrost all confirmed working. Window open/close was tried and confirmed not to work, see above, it's not exposed as a switch. Pre-conditioning (the remote aircon) is implemented as of 0.9.0, and starting it is confirmed accepted by the car as of 0.9.4; stopping it has not been exercised yet.

Not yet submitted for [Homebridge plugin verification](https://github.com/homebridge/plugins/wiki/Verified-Plugins). The main functional blocker (confirming lock/unlock against real hardware) is now resolved, submission is just a matter of deciding to do it. See `CHANGELOG.md` for release history.

## Contributing

Issues and pull requests are welcome. This project doesn't have a dedicated Discord or support channel, please use [GitHub Issues](https://github.com/andrew-snape/homebridge-mg-saic/issues) for bug reports and feature requests.

## License

MIT, see [`LICENSE`](LICENSE).
