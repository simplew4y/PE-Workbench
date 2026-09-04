import assert from "node:assert/strict";
import test from "node:test";
import { appearanceFrame, getSurfaceAppearance, accessibleColor, contrastRatio } from "./appearance.ts";

function surface(name) {
  return {
    version: 1,
    surface_id: name.toLowerCase(),
    component: {
      kind: "company_overview",
      name,
      metrics: [
        { label: "Revenue", value: "1" },
        { label: "Profit", value: "2" },
        { label: "People", value: "3" },
      ],
    },
  };
}

test("appearance selection is stable for history replay", () => {
  const input = surface("BYD");
  assert.deepEqual(getSurfaceAppearance(input), getSurfaceAppearance(input));
});

test("content changes do not randomly change layout or theme", () => {
  assert.deepEqual(getSurfaceAppearance(surface("BYD")), getSurfaceAppearance(surface("Tesla")));
  assert.equal(getSurfaceAppearance(surface("BYD")).presentation.interaction, "static");
});

test("explicit presentation intent controls skin independently of interaction", () => {
  const appearances = ["neutral", "cool", "warm", "ink"].map((theme) => getSurfaceAppearance({ ...surface("BYD"), presentation: { theme, treatment: "soft" } }));
  assert.equal(new Set(appearances.map((item) => item.palette.name)).size, 4);
  assert.ok(appearances.every((item) => item.presentation.interaction === "static"));
});

test("timeline carousel requires explore, not a random variant", () => {
  const input = { version: 1, component: { kind: "research_timeline", title: "Events", events: [] } };
  assert.equal(getSurfaceAppearance(input).variant, 0);
  assert.equal(getSurfaceAppearance({ ...input, presentation: { interaction: "explore" } }).variant, 1);
});

test("surface frame always fills the answer column without dead side space", () => {
  const frame = appearanceFrame(getSurfaceAppearance(surface("BYD")));
  assert.equal(frame.width, "100%");
  assert.equal("marginLeft" in frame, false);
  assert.equal("marginRight" in frame, false);
});

test("AI custom colors are preserved when readable and corrected when invisible", () => {
  const input = {...surface("BYD"),presentation:{palette:{accent:"#663399",series:["#884422","#226688"]},treatment:"paper"}};
  const appearance = getSurfaceAppearance(input);
  assert.equal(appearance.palette.name, "custom");
  const frame = appearanceFrame(appearance);
  assert.equal(frame["--pe-accent-light"], "#663399");
  assert.equal(frame["--pe-series-0-light"], "#884422");
  assert.ok(contrastRatio(accessibleColor("#ffffff", "#ffffff", 3), "#ffffff") >= 3);
  assert.ok(contrastRatio(accessibleColor("#000000", "#0f172a", 3), "#0f172a") >= 3);
  assert.equal("--pe-source-color" in frame, false);
});
