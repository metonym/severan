import {
  join,
  OBJECT,
  possible,
  UNDEFINED,
  UNKNOWN,
  type Value,
} from "./values";

/** One place a library component is rendered. */
export type CallSite = {
  /** Library module key, relative to its `srcDir`: `Button/Button.svelte`. */
  component: string;
  /** Every prop and slot is unknown: props are spread, or it's used as a value. */
  open: boolean;
  props: Map<string, Value>;
  /** Slots this site fills (a snippet fills its name's); `null` when that can't be told. */
  slots: Set<string> | null;
  /** Has content outside any snippet or `slot="…"`: Svelte 5's `children`. */
  children?: boolean;
  /** `bind:this` members read off the instance; `null` if used otherwise. */
  instance?: ReadonlySet<string> | null;
  /** Only set for app files, for the report. */
  location?: { file: string; line: number };
  reason?: string;
  /** Per unknown prop; a function is only called if no earlier site gave one. */
  why?: Map<string, string | (() => string | undefined)>;
};

export type ComponentUsage = {
  open: boolean;
  props: Map<string, Value>;
  /** Props some site leaves out: their default applies, or they're absent. */
  omitted: Set<string>;
  /** `$$slots[name]` across sites; Svelte only sets filled slots' keys. */
  slots: Map<string, Value>;
  slotsUnknown: boolean;
  siteCount: number;
  appSites: CallSite[];
  openReason?: string;
  /** Why each unknown prop is unknown, from the first site that made it so. */
  unknownBecause: Map<string, string>;
};

export function newComponentUsage(open = false): ComponentUsage {
  return {
    open,
    props: new Map(),
    omitted: new Set(),
    slots: new Map(),
    slotsUnknown: false,
    siteCount: 0,
    appSites: [],
    unknownBecause: new Map(),
  };
}

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === UNKNOWN || b === UNKNOWN) {
    return false;
  }
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

/**
 * Opens `site` when its target can get props no call site shows: a custom
 * element, or a `bind:this` instance (`$set`, accessors, handed on).
 */
export function checkTarget(
  site: CallSite,
  target: {
    propNames: ReadonlyMap<string, string>;
    customElement: boolean;
  },
): CallSite {
  if (site.open) return site;
  if (target.customElement) {
    return { ...site, open: true, reason: "is a custom element" };
  }
  const { instance } = site;
  if (instance === undefined) return site;
  const props = new Set(target.propNames.values());
  if (instance === null || [...instance].some((name) => props.has(name))) {
    return {
      ...site,
      open: true,
      reason: "is bound with `bind:this`, and its instance may set its props",
    };
  }
  return site;
}

/** Content is `children` in Svelte 5, only a slot in 3/4; unknown version, either. */
function propsOf(
  site: CallSite,
  svelteMajor: number | undefined,
): Map<string, Value> {
  if (!site.children || (svelteMajor !== undefined && svelteMajor < 5)) {
    return site.props;
  }
  const props = new Map(site.props);
  props.set(
    "children",
    svelteMajor === undefined
      ? join(site.props.get("children") ?? UNDEFINED, possible(OBJECT))
      : possible(OBJECT),
  );
  return props;
}

/** Returns whether anything the analysis reads changed, to walk again. */
export function addCallSite(
  usage: ComponentUsage,
  site: CallSite,
  propNames: Iterable<string>,
  svelteMajor: number | undefined,
): boolean {
  let changed = usage.siteCount === 0;
  const props = propsOf(site, svelteMajor);
  if (site.location) usage.appSites.push(site);

  if (site.open && !usage.open) {
    usage.open = true;
    usage.openReason = site.reason;
    changed = true;
  }
  for (const [name, why] of site.why ?? []) {
    if (usage.unknownBecause.has(name)) continue;
    const reason = typeof why === "string" ? why : why();
    if (reason) usage.unknownBecause.set(name, reason);
  }

  for (const [name, value] of props) {
    const before = usage.props.get(name);
    // A key earlier sites didn't pass was absent there.
    if (
      usage.siteCount > 0 &&
      before === undefined &&
      !usage.omitted.has(name)
    ) {
      usage.omitted.add(name);
      changed = true;
    }
    const after = before === undefined ? value : join(before, value);
    if (!sameValue(before, after)) {
      usage.props.set(name, after);
      changed = true;
    }
  }
  // Declared props and every key some site passes: absent here.
  const markAbsent = (name: string) => {
    if (!(props.has(name) || usage.omitted.has(name))) {
      usage.omitted.add(name);
      changed = true;
    }
  };
  for (const name of propNames) markAbsent(name);
  for (const name of usage.props.keys()) markAbsent(name);

  if (site.slots === null) {
    if (!usage.slotsUnknown) changed = true;
    usage.slotsUnknown = true;
  } else {
    const names = new Set([...usage.slots.keys(), ...site.slots]);
    for (const name of names) {
      const before = usage.slots.get(name);
      // A slot first filled here was empty at every earlier site.
      const base =
        before ?? (usage.siteCount > 0 ? possible(undefined) : possible());
      const after = join(
        base,
        possible(site.slots.has(name) ? true : undefined),
      );
      if (!sameValue(before, after)) {
        usage.slots.set(name, after);
        changed = true;
      }
    }
  }

  usage.siteCount++;
  return changed;
}
