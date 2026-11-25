import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { launchdPlist, serviceLabel, serviceSpec, systemdUnits } from "../src/service.js";

const config = parseConfig({ projects: {}, pollSeconds: 90 }, "/Users/me/my queue");

test("each queue folder gets its own service label", () => {
  assert.match(serviceLabel("/a"), /^dev\.nightshift\.[0-9a-f]{8}$/);
  assert.notEqual(serviceLabel("/a"), serviceLabel("/b"));
});

test("the launchd agent runs 'run' for this queue on an interval and leaves the workers alone", () => {
  const plist = launchdPlist({ ...serviceSpec(config), node: "/opt/node", cli: "/app/cli.js", path: "/opt/bin:/usr/bin", home: "/Users/me", log: "/q/service.log" });
  assert.match(plist, /<string>\/opt\/node<\/string>\s*<string>\/app\/cli\.js<\/string>\s*<string>run<\/string>\s*<string>--root<\/string>\s*<string>\/Users\/me\/my queue<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>90<\/integer>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/bin:\/usr\/bin<\/string>/);
});

test("the systemd units run 'run' on a timer and do not kill the workers", () => {
  const units = systemdUnits({ ...serviceSpec(config), node: "/opt/node", cli: "/app/cli.js", path: "/opt/bin", home: "/home/me", log: "/q/service.log" });
  assert.match(units.service, /ExecStart=\/opt\/node \/app\/cli\.js run --root "\/Users\/me\/my queue"/);
  assert.match(units.service, /KillMode=process/);
  assert.match(units.timer, /OnUnitActiveSec=90/);
  assert.equal(parseConfig({ pollSeconds: 5 }, "/q").pollSeconds, 30, "polling is never more often than every 30s");
});

test("config env goes into the launchd agent and the systemd unit, escaped", () => {
  const withEnv = parseConfig({ projects: {}, env: { GH_CONFIG_DIR: "/Users/me/.config/gh-b", NOTE: "a<b & 50%" } }, "/q");
  assert.deepEqual(parseConfig({}, "/q").env, {});
  const plist = launchdPlist(serviceSpec(withEnv));
  assert.match(plist, /<key>GH_CONFIG_DIR<\/key><string>\/Users\/me\/\.config\/gh-b<\/string>/);
  assert.match(plist, /<key>NOTE<\/key><string>a&lt;b &amp; 50%<\/string>/);
  const unit = systemdUnits(serviceSpec(withEnv)).service;
  assert.match(unit, /^Environment=GH_CONFIG_DIR=\/Users\/me\/\.config\/gh-b$/m);
  assert.match(unit, /^Environment="NOTE=a<b & 50%%"$/m);
});

test("config env must be strings with valid names", () => {
  assert.throws(() => parseConfig({ env: { A: 1 } }, "/q"), /config\.env\.A must be a string/);
  assert.throws(() => parseConfig({ env: { "a-b": "x" } }, "/q"), /not a valid environment variable name/);
  assert.throws(() => parseConfig({ env: "x" }, "/q"), /config\.env must be an object/);
});
