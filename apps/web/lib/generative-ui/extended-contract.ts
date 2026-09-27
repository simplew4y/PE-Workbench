// Shared contract: schema parity with pe-boot is checked by regression tests.
export type MediaItem = { title: string; src: string; caption?: string };
export type Gallery = {
  kind: "image_gallery";
  title: string;
  layout: "grid" | "carousel";
  images: MediaItem[];
};
export type Entities = {
  kind: "entity_cards";
  title: string;
  layout: "grid" | "carousel";
  entities: {
    name: string;
    category: string;
    description: string;
    image?: string;
    url?: string;
    facts: { label: string; value: string }[];
  }[];
};
export type Places = {
  kind: "place_map";
  title: string;
  places: {
    name: string;
    latitude: number;
    longitude: number;
    description: string;
  }[];
};
export type Calculator = {
  kind: "scenario_calculator";
  title: string;
  description: string;
  operation: "product" | "sum" | "ratio" | "compound";
  resultLabel: string;
  resultUnit: string;
  inputs: {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    unit: string;
  }[];
};
export type Sankey = {
  kind: "sankey_chart";
  title: string;
  unit: string;
  nodes: string[];
  links: { source: string; target: string; value: number }[];
};
export type Radar = {
  kind: "radar_chart";
  title: string;
  indicators: { name: string; max: number }[];
  series: { name: string; values: number[] }[];
};
export type Candlestick = {
  kind: "candlestick_chart";
  title: string;
  unit: string;
  candles: {
    date: string;
    open: number;
    close: number;
    low: number;
    high: number;
  }[];
};
export type ExtendedComponent =
  | Gallery
  | Entities
  | Places
  | Calculator
  | Sankey
  | Radar
  | Candlestick;

type Schema = {
  type?: string;
  const?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
const str: Schema = { type: "string", minLength: 1, maxLength: 500 };
const num: Schema = { type: "number", minimum: -1e15, maximum: 1e15 };
const arr = (items: Schema, minItems = 1, maxItems = 20): Schema => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
const obj = (
  properties: Record<string, Schema>,
  optional: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const choice = (...values: string[]): Schema => ({
  type: "string",
  enum: values,
});
const kind = (value: string): Schema => ({ type: "string", const: value });
const uri: Schema = { type: "string", minLength: 1, maxLength: 2000 };
export const extendedSchemas: Schema[] = [
  obj({
    kind: kind("image_gallery"),
    title: str,
    layout: choice("grid", "carousel"),
    images: arr(
      obj({ title: str, src: uri, caption: str }, ["caption"]),
      1,
      12,
    ),
  }),
  obj({
    kind: kind("entity_cards"),
    title: str,
    layout: choice("grid", "carousel"),
    entities: arr(
      obj(
        {
          name: str,
          category: str,
          description: str,
          image: uri,
          url: uri,
          facts: arr(obj({ label: str, value: str }), 0, 8),
        },
        ["image", "url"],
      ),
      1,
      12,
    ),
  }),
  obj({
    kind: kind("place_map"),
    title: str,
    places: arr(
      obj({
        name: str,
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        description: str,
      }),
      1,
      20,
    ),
  }),
  obj({
    kind: kind("scenario_calculator"),
    title: str,
    description: str,
    operation: choice("product", "sum", "ratio", "compound"),
    resultLabel: str,
    resultUnit: str,
    inputs: arr(
      obj({
        id: str,
        label: str,
        min: num,
        max: num,
        step: num,
        value: num,
        unit: str,
      }),
      2,
      6,
    ),
  }),
  obj({
    kind: kind("sankey_chart"),
    title: str,
    unit: str,
    nodes: arr(str, 2, 24),
    links: arr(
      obj({
        source: str,
        target: str,
        value: { type: "number", minimum: 0, maximum: 1e15 },
      }),
      1,
      48,
    ),
  }),
  obj({
    kind: kind("radar_chart"),
    title: str,
    indicators: arr(
      obj({
        name: str,
        max: { type: "number", minimum: 0.000001, maximum: 1e15 },
      }),
      3,
      10,
    ),
    series: arr(obj({ name: str, values: arr(num, 3, 10) }), 1, 6),
  }),
  obj({
    kind: kind("candlestick_chart"),
    title: str,
    unit: str,
    candles: arr(
      obj({ date: str, open: num, close: num, low: num, high: num }),
      2,
      300,
    ),
  }),
];
export const extendedKinds = extendedSchemas.map(
  (schema) => schema.properties?.kind.const as string,
);

function check(schema: Schema, value: unknown, path: string): void {
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(path + " invalid kind");
  if (schema.enum && !schema.enum.includes(value as string))
    throw new Error(path + " invalid option");
  if (
    schema.type === "string" &&
    (typeof value !== "string" ||
      !value.trim() ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 2000))
  )
    throw new Error(path + " invalid text");
  if (
    schema.type === "number" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    throw new Error(path + " invalid number");
  if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 300)
    )
      throw new Error(path + " invalid array");
    value.forEach((item, index) =>
      check(schema.items!, item, path + "[" + index + "]"),
    );
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(path + " invalid object");
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) throw new Error(path + "." + key + " required");
    for (const key of Object.keys(record)) {
      if (!schema.properties || !Object.hasOwn(schema.properties, key))
        throw new Error(path + "." + key + " unsupported");
      check(schema.properties[key], record[key], path + "." + key);
    }
  }
}
export function safeMediaSource(value: string): boolean {
  // Local images use the existing authorized file route; never accept data/SVG/script URLs.
  if (value.startsWith("/") && !value.startsWith("//"))
    return !value.includes("\\") && /\.(png|jpe?g|webp|gif|bmp)$/i.test(value);
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function parseExtendedComponent(value: unknown): ExtendedComponent {
  const index = extendedKinds.indexOf((value as { kind?: string })?.kind ?? "");
  if (index < 0) throw new Error("unsupported extended component");
  check(extendedSchemas[index], value, "component");
  const c = value as ExtendedComponent;
  if (
    c.kind === "image_gallery" &&
    c.images.some((item) => !safeMediaSource(item.src))
  )
    throw new Error("unsafe image source");
  if (c.kind === "entity_cards")
    for (const item of c.entities) {
      if (item.image && !safeMediaSource(item.image))
        throw new Error("unsafe image source");
      if (item.url) {
        const url = new URL(item.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("unsafe entity URL");
      }
    }
  if (c.kind === "scenario_calculator") {
    if (new Set(c.inputs.map((item) => item.id)).size !== c.inputs.length)
      throw new Error("duplicate input IDs");
    for (const input of c.inputs)
      if (
        input.min >= input.max ||
        input.step <= 0 ||
        input.step > input.max - input.min ||
        input.value < input.min ||
        input.value > input.max
      )
        throw new Error("invalid slider bounds");
    if (c.operation === "ratio" && c.inputs.length !== 2)
      throw new Error("ratio requires numerator and denominator");
    if (
      c.operation === "compound" &&
      (c.inputs.length !== 3 ||
        c.inputs[1].min < -100 ||
        c.inputs[2].min < 0 ||
        c.inputs[2].max > 100)
    )
      throw new Error(
        "compound requires principal, rate percent, periods 0..100",
      );
  }
  if (c.kind === "sankey_chart") {
    const names = new Set(c.nodes);
    if (names.size !== c.nodes.length)
      throw new Error("duplicate sankey nodes");
    const graph = new Map(c.nodes.map((name) => [name, [] as string[]]));
    for (const link of c.links) {
      if (!names.has(link.source) || !names.has(link.target))
        throw new Error("unknown sankey node");
      graph.get(link.source)!.push(link.target);
    }
    const active = new Set<string>(),
      done = new Set<string>();
    const visit = (name: string): void => {
      if (active.has(name)) throw new Error("sankey must be acyclic");
      if (done.has(name)) return;
      active.add(name);
      for (const next of graph.get(name)!) visit(next);
      active.delete(name);
      done.add(name);
    };
    c.nodes.forEach(visit);
  }
  if (
    c.kind === "radar_chart" &&
    c.series.some(
      (series) =>
        series.values.length !== c.indicators.length ||
        series.values.some((n, i) => n < 0 || n > c.indicators[i].max),
    )
  )
    throw new Error("radar values must align with indicator bounds");
  if (c.kind === "candlestick_chart") {
    if (new Set(c.candles.map((item) => item.date)).size !== c.candles.length)
      throw new Error("duplicate candle dates");
    if (
      c.candles.some(
        (item) =>
          item.low > Math.min(item.open, item.close) ||
          item.high < Math.max(item.open, item.close),
      )
    )
      throw new Error("invalid OHLC bounds");
  }
  return c;
}
export function calculateScenario(
  operation: Calculator["operation"],
  values: number[],
): number | null {
  let result: number;
  if (operation === "sum") result = values.reduce((a, b) => a + b, 0);
  else if (operation === "product") result = values.reduce((a, b) => a * b, 1);
  else if (operation === "ratio")
    result = values[1] === 0 ? NaN : values[0] / values[1];
  else result = values[0] * (1 + values[1] / 100) ** values[2];
  return Number.isFinite(result) ? result : null;
}
