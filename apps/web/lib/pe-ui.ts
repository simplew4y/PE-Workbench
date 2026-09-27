export type PeUiMetric = { label: string; value: string };
export type PeUiSeries = { name: string; values: number[]; unit?: string };

export type PeUiBlock =
  | {
      version: 1;
      type: "entity-card";
      entity: "company" | "product" | "person" | "place";
      name: string;
      subtitle?: string;
      description?: string;
      metrics?: PeUiMetric[];
    }
  | {
      version: 1;
      type: "chart";
      chart: "bar" | "line" | "pie";
      title: string;
      categories: string[];
      series: PeUiSeries[];
    }
  | {
      version: 1;
      type: "timeline";
      title?: string;
      events: Array<{ date: string; title: string; description?: string }>;
    }
  | {
      version: 1;
      type: "gallery";
      title?: string;
      files: Array<{ path: string; caption?: string; alt?: string }>;
    }
  | {
      version: 1;
      type: "source-list";
      title?: string;
      sources: Array<{ title: string; url?: string; filePath?: string; description?: string }>;
    };

export type PeUiParseResult =
  | { success: true; block: PeUiBlock }
  | { success: false; error: string };

const MAX_TEXT = 500;
const MAX_ITEMS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(`${field} must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function readTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    throw new Error(`${field} must contain between 1 and ${MAX_ITEMS} items`);
  }
  return value.map((item, index) => readText(item, `${field}[${index}]`) as string);
}

function readOptionalTitle(value: unknown): string | undefined {
  return readText(value, "title", false);
}

function parseEntity(value: Record<string, unknown>): PeUiBlock {
  const entity = value.entity;
  if (entity !== "company" && entity !== "product" && entity !== "person" && entity !== "place") {
    throw new Error("entity must be company, product, person, or place");
  }
  let metrics: PeUiMetric[] | undefined;
  if (value.metrics !== undefined) {
    if (!Array.isArray(value.metrics) || value.metrics.length > 8) throw new Error("metrics must contain at most 8 items");
    metrics = value.metrics.map((metric, index) => {
      if (!isRecord(metric)) throw new Error(`metrics[${index}] must be an object`);
      return {
        label: readText(metric.label, `metrics[${index}].label`) as string,
        value: readText(metric.value, `metrics[${index}].value`) as string,
      };
    });
  }
  return {
    version: 1,
    type: "entity-card",
    entity,
    name: readText(value.name, "name") as string,
    subtitle: readText(value.subtitle, "subtitle", false),
    description: readText(value.description, "description", false),
    ...(metrics?.length ? { metrics } : {}),
  };
}

function parseChart(value: Record<string, unknown>): PeUiBlock {
  const chart = value.chart;
  if (chart !== "bar" && chart !== "line" && chart !== "pie") throw new Error("chart must be bar, line, or pie");
  const categories = readTextArray(value.categories, "categories");
  if (!Array.isArray(value.series) || value.series.length === 0 || value.series.length > 4) {
    throw new Error("series must contain between 1 and 4 items");
  }
  const series = value.series.map((item, index): PeUiSeries => {
    if (!isRecord(item)) throw new Error(`series[${index}] must be an object`);
    if (!Array.isArray(item.values) || item.values.length !== categories.length) {
      throw new Error(`series[${index}].values must match categories length`);
    }
    const values = item.values.map((number, valueIndex) => {
      if (typeof number !== "number" || !Number.isFinite(number)) {
        throw new Error(`series[${index}].values[${valueIndex}] must be a finite number`);
      }
      return number;
    });
    return {
      name: readText(item.name, `series[${index}].name`) as string,
      values,
      unit: readText(item.unit, `series[${index}].unit`, false),
    };
  });
  if (chart === "pie" && series.length !== 1) throw new Error("pie charts support exactly one series");
  if (chart === "pie" && series[0].values.some((number) => number < 0)) throw new Error("pie chart values cannot be negative");
  return {
    version: 1,
    type: "chart",
    chart,
    title: readText(value.title, "title") as string,
    categories,
    series,
  };
}

function parseTimeline(value: Record<string, unknown>): PeUiBlock {
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_ITEMS) {
    throw new Error(`events must contain between 1 and ${MAX_ITEMS} items`);
  }
  return {
    version: 1,
    type: "timeline",
    title: readOptionalTitle(value.title),
    events: value.events.map((event, index) => {
      if (!isRecord(event)) throw new Error(`events[${index}] must be an object`);
      return {
        date: readText(event.date, `events[${index}].date`) as string,
        title: readText(event.title, `events[${index}].title`) as string,
        description: readText(event.description, `events[${index}].description`, false),
      };
    }),
  };
}

function parseGallery(value: Record<string, unknown>): PeUiBlock {
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 12) {
    throw new Error("files must contain between 1 and 12 items");
  }
  return {
    version: 1,
    type: "gallery",
    title: readOptionalTitle(value.title),
    files: value.files.map((file, index) => {
      if (!isRecord(file)) throw new Error(`files[${index}] must be an object`);
      return {
        path: readText(file.path, `files[${index}].path`) as string,
        caption: readText(file.caption, `files[${index}].caption`, false),
        alt: readText(file.alt, `files[${index}].alt`, false),
      };
    }),
  };
}

function parseSources(value: Record<string, unknown>): PeUiBlock {
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_ITEMS) {
    throw new Error(`sources must contain between 1 and ${MAX_ITEMS} items`);
  }
  return {
    version: 1,
    type: "source-list",
    title: readOptionalTitle(value.title),
    sources: value.sources.map((source, index) => {
      if (!isRecord(source)) throw new Error(`sources[${index}] must be an object`);
      const url = readText(source.url, `sources[${index}].url`, false);
      const filePath = readText(source.filePath, `sources[${index}].filePath`, false);
      if (!url && !filePath) throw new Error(`sources[${index}] requires url or filePath`);
      if (url && !/^https?:\/\//i.test(url)) throw new Error(`sources[${index}].url must use http or https`);
      return {
        title: readText(source.title, `sources[${index}].title`) as string,
        url,
        filePath,
        description: readText(source.description, `sources[${index}].description`, false),
      };
    }),
  };
}

export function parsePeUiBlock(raw: string): PeUiParseResult {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error("pe-ui content must be a JSON object");
    if (value.version !== 1) throw new Error("version must be 1");
    let block: PeUiBlock;
    switch (value.type) {
      case "entity-card": block = parseEntity(value); break;
      case "chart": block = parseChart(value); break;
      case "timeline": block = parseTimeline(value); break;
      case "gallery": block = parseGallery(value); break;
      case "source-list": block = parseSources(value); break;
      default: throw new Error("unsupported pe-ui block type");
    }
    return { success: true, block };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Invalid pe-ui block" };
  }
}
