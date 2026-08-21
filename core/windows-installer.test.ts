import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createWindowsEnvironmentBackend,
} from "./windows-installer.ts";

test("the Windows test environment backend preserves unrelated values and uses compare-and-set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "windows-installer-env-"));
  const store = path.join(root, "user home with spaces", "environment.json");
  try {
    await mkdir(path.dirname(store), { recursive: true });
    await writeFile(store, `${JSON.stringify({ KEEP_ME: "yes" }, null, 2)}\n`);
    const backend = createWindowsEnvironmentBackend(store);

    await backend.replace({
      key: "KILO_CONFIG_DIR",
      expectedValue: undefined,
      value: "C:\\workflow checkout",
    });
    assert.equal(await backend.read("KILO_CONFIG_DIR"), "C:\\workflow checkout");
    assert.deepEqual(JSON.parse(await readFile(store, "utf8")), {
      KEEP_ME: "yes",
      KILO_CONFIG_DIR: "C:\\workflow checkout",
    });

    await assert.rejects(
      backend.replace({
        key: "KILO_CONFIG_DIR",
        expectedValue: "C:\\old checkout",
        value: "C:\\new checkout",
      }),
      /Concurrent user environment change/,
    );

    await backend.replace({
      key: "KILO_CONFIG_DIR",
      expectedValue: "C:\\workflow checkout",
      value: undefined,
    });
    assert.equal(await backend.read("KILO_CONFIG_DIR"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
