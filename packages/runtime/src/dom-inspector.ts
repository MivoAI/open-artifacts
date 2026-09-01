import {
  domInspectorContract,
  type DomInspectorContext,
  type DomInspectorItem,
  type DomInspectorSelection,
  type DomInspectorSelector,
  type DomInspectorTextRange,
  type TargetProvider,
} from '@open-artifacts/sdk';

import { RuntimeError } from './errors.js';

function invalid(message: string): never {
  throw new RuntimeError('DOM_INSPECTOR_SELECTION_INVALID', message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximumLength: number) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    invalid(`${label} cannot exceed ${maximumLength} characters`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maximumLength: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximumLength) {
    invalid(`${label} cannot exceed ${maximumLength} characters`);
  }
  return normalized;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${label} must be a finite number`);
  }
  return Math.round(value * 100) / 100;
}

function normalizeRect(value: unknown, index: number): DomInspectorItem['rect'] {
  if (value === undefined) return undefined;
  const source = record(value, `items[${index}].rect`);
  return {
    height: finiteNumber(source.height, `items[${index}].rect.height`),
    width: finiteNumber(source.width, `items[${index}].rect.width`),
    x: finiteNumber(source.x, `items[${index}].rect.x`),
    y: finiteNumber(source.y, `items[${index}].rect.y`),
  };
}

function normalizeBoundary(value: unknown, label: string) {
  const source = record(value, label);
  const offset = source.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    invalid(`${label}.offset must be a non-negative integer`);
  }
  return {
    offset,
    selector: requiredString(
      source.selector,
      `${label}.selector`,
      domInspectorContract.maximumSelectorLength,
    ),
  };
}

function normalizeTextRange(value: unknown, index: number): DomInspectorTextRange | undefined {
  if (value === undefined) return undefined;
  const source = record(value, `items[${index}].textRange`);
  return {
    end: normalizeBoundary(source.end, `items[${index}].textRange.end`),
    start: normalizeBoundary(source.start, `items[${index}].textRange.start`),
    textQuote: requiredString(
      source.textQuote,
      `items[${index}].textRange.textQuote`,
      domInspectorContract.maximumTextLength,
    ),
  };
}

function normalizeSelection(value: unknown): DomInspectorSelection {
  const source = record(value, 'DOM Inspector selection');
  if (!Array.isArray(source.items) || source.items.length === 0) {
    invalid('DOM Inspector selection must contain at least one item');
  }
  if (source.items.length > domInspectorContract.maximumItems) {
    invalid(
      `DOM Inspector selection cannot contain more than ${domInspectorContract.maximumItems} items`,
    );
  }
  return {
    items: source.items.map((value, index) => {
      const item = record(value, `items[${index}]`);
      const accessibleName = optionalString(
        item.accessibleName,
        `items[${index}].accessibleName`,
        domInspectorContract.maximumAccessibleNameLength,
      );
      const role = optionalString(item.role, `items[${index}].role`, 80);
      const text = optionalString(
        item.text,
        `items[${index}].text`,
        domInspectorContract.maximumTextLength,
      );
      const rect = normalizeRect(item.rect, index);
      const textRange = normalizeTextRange(item.textRange, index);
      return {
        ...(accessibleName === undefined ? {} : { accessibleName }),
        ...(rect === undefined ? {} : { rect }),
        ...(role === undefined ? {} : { role }),
        selector: requiredString(
          item.selector,
          `items[${index}].selector`,
          domInspectorContract.maximumSelectorLength,
        ),
        tagName: requiredString(item.tagName, `items[${index}].tagName`, 64).toLowerCase(),
        ...(text === undefined ? {} : { text }),
        ...(textRange === undefined ? {} : { textRange }),
      };
    }),
  };
}

function targetLabel(item: DomInspectorItem) {
  return item.accessibleName ?? item.text ?? `<${item.tagName}>`;
}

export function createDomInspectorTargetProvider(): TargetProvider<
  unknown,
  DomInspectorSelector,
  DomInspectorContext
> {
  return {
    name: domInspectorContract.provider,
    title: 'DOM Inspector fallback',
    describe(selection) {
      const normalized = normalizeSelection(selection);
      const firstItem = normalized.items[0]!;
      const first = firstItem.textRange?.textQuote ?? targetLabel(firstItem);
      return {
        context: {
          count: normalized.items.length,
          items: normalized.items,
        },
        presentation: {
          fields: [
            { label: 'Elements', value: String(normalized.items.length) },
            { label: 'Selector', value: firstItem.selector },
          ],
          summary:
            normalized.items.length === 1
              ? first
              : `${first} and ${normalized.items.length - 1} more`,
          title:
            normalized.items.length === 1
              ? firstItem.textRange
                ? 'Text selected'
                : 'Element selected'
              : `${normalized.items.length} elements selected`,
        },
        selector: {
          items: normalized.items.map((item) => ({
            css: item.selector,
            ...(item.text === undefined ? {} : { textQuote: item.text }),
            ...(item.textRange === undefined ? {} : { textRange: item.textRange }),
          })),
          type: 'DomInspectorSelector',
          version: 1,
        },
      };
    },
    resolve() {
      return {
        reason:
          'DOM Inspector fallback targets require the live Artifact UI; select the target again before acting.',
        status: 'unsupported',
      };
    },
  };
}
