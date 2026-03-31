/**
 * Simple line-by-line YAML parser for cf-monitor.yaml.
 *
 * Zero npm dependencies. Handles the known cf-monitor.yaml structure:
 * flat values, one-level nesting, $ENV_VAR references, arrays, numbers, booleans.
 * Keeps $VARIABLE references as-is (resolved at runtime by parseConfig).
 *
 * NOT a general-purpose YAML parser — only supports the cf-monitor.yaml schema.
 */

export function parseYamlConfig(content: string): string {
	const result: Record<string, unknown> = {};
	let currentSection: string | undefined;
	let currentSubSection: string | undefined;

	for (const rawLine of content.split('\n')) {
		const line = rawLine.replace(/#.*$/, '').trimEnd(); // strip comments
		if (!line.trim()) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		// Top-level section (indent 0)
		if (indent === 0 && trimmed.endsWith(':')) {
			currentSection = trimmed.slice(0, -1);
			currentSubSection = undefined;
			if (!result[currentSection]) {
				result[currentSection] = {};
			}
			continue;
		}

		// Array item (- "value")
		if (trimmed.startsWith('- ') && currentSection) {
			const section = result[currentSection] as Record<string, unknown>;
			if (!Array.isArray(section)) {
				// Top-level array (e.g. exclude:)
				result[currentSection] = result[currentSection] ?? [];
				if (Array.isArray(result[currentSection])) {
					(result[currentSection] as unknown[]).push(parseValue(trimmed.slice(2).trim()));
				}
			}
			continue;
		}

		// Key: value pair
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const rawValue = trimmed.slice(colonIdx + 1).trim();

		if (!currentSection) continue;

		// Sub-section (indent 2, no value)
		if (indent === 2 && !rawValue) {
			currentSubSection = key;
			const section = result[currentSection] as Record<string, unknown>;
			if (!section[key]) {
				section[key] = {};
			}
			continue;
		}

		// Sub-sub value (indent 4+, inside sub-section)
		if (indent >= 4 && currentSubSection) {
			const section = result[currentSection] as Record<string, Record<string, unknown>>;
			if (section[currentSubSection] && typeof section[currentSubSection] === 'object') {
				section[currentSubSection][key] = parseValue(rawValue);
			}
			continue;
		}

		// Direct value (indent 2, inside section)
		if (indent === 2) {
			currentSubSection = undefined;
			const section = result[currentSection] as Record<string, unknown>;
			section[key] = parseValue(rawValue);
		}
	}

	return JSON.stringify(result);
}

function parseValue(raw: string): unknown {
	// Remove surrounding quotes
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}

	// $ENV_VAR reference — keep as-is
	if (raw.startsWith('$')) return raw;

	// Boolean
	if (raw === 'true') return true;
	if (raw === 'false') return false;

	// Number (including underscore notation like 1_000_000)
	const numStr = raw.replace(/_/g, '');
	if (/^\d+(\.\d+)?$/.test(numStr)) return Number(numStr);

	return raw;
}
