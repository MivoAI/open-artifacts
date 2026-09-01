import { createOaBrowserClient } from '@open-artifacts/runtime/browser';
import type { RuntimeEvent } from '@open-artifacts/runtime';
import {
  domInspectorContract,
  type ArtifactRenderProps,
  type DomInspectorItem,
  type DomInspectorSelection,
  type DomInspectorTextRange,
  type JsonValue,
  type OaSdk,
  type TargetDescriptor,
} from '@open-artifacts/sdk';
import { annotationActionEvent, type AnnotationActionCandidate } from '@open-artifacts/sdk/react';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

interface ArtifactMeta {
  name: string;
  version: string;
}

interface TargetSelection {
  descriptor: TargetDescriptor<JsonValue, JsonValue>;
  provider: string;
  selection: JsonValue;
}

interface Annotation {
  id: string;
  body: string;
  status: string;
  targetSnapshot: {
    presentation: {
      title: string;
      summary?: string;
    };
  };
}

interface Tool {
  name: string;
  title: string;
  description: string;
  effects: {
    data: 'none' | 'read' | 'write';
  };
}

interface InspectedElement {
  element: Element;
  item: DomInspectorItem;
}

interface WorkbenchProps<TInput> {
  Artifact: ComponentType<ArtifactRenderProps<TInput> & { data?: TInput }>;
  artifact: ArtifactMeta;
  input: TInput;
  instanceId: string;
  oa: OaSdk;
}

function escapeAttributeValue(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function elementSelector(element: Element, stage: Element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid="${escapeAttributeValue(testId)}"]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${escapeAttributeValue(ariaLabel)}"]`;
  }

  const path: string[] = [];
  let current: Element | null = element;
  while (current && current !== stage) {
    const tagName = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (sibling) => sibling.tagName === current!.tagName,
        )
      : [];
    const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
    path.unshift(`${tagName}${position}`);
    current = current.parentElement;
  }
  return path.join(' > ');
}

function normalizedText(element: Element) {
  const text = (element as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, domInspectorContract.maximumTextLength) : undefined;
}

function accessibleName(element: Element, text: string | undefined) {
  const explicit =
    element.getAttribute('aria-label') ??
    element.getAttribute('alt') ??
    element.getAttribute('title') ??
    element.getAttribute('placeholder');
  return (explicit?.trim() || text)?.slice(0, domInspectorContract.maximumAccessibleNameLength);
}

function inspectElement(element: Element, stage: Element): InspectedElement {
  const text = normalizedText(element);
  const name = accessibleName(element, text);
  const rect = element.getBoundingClientRect();
  const role = element.getAttribute('role')?.trim();
  return {
    element,
    item: {
      ...(name ? { accessibleName: name } : {}),
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      },
      ...(role ? { role } : {}),
      selector: elementSelector(element, stage),
      tagName: element.tagName.toLowerCase(),
      ...(text ? { text } : {}),
    },
  };
}

function elementForNode(node: Node) {
  return node instanceof Element ? node : (node.parentElement ?? undefined);
}

function inspectTextRange(selection: Selection, stage: Element): InspectedElement | undefined {
  if (selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const start = elementForNode(range.startContainer);
  const end = elementForNode(range.endContainer);
  if (!start || !end || !stage.contains(start) || !stage.contains(end)) return undefined;
  if (start.closest('[data-oa-target-provider]') || end.closest('[data-oa-target-provider]')) {
    return undefined;
  }
  const quote = selection
    .toString()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, domInspectorContract.maximumTextLength);
  if (!quote) return undefined;
  const common = elementForNode(range.commonAncestorContainer);
  const element = common && common !== stage ? common : start;
  const rect = range.getBoundingClientRect();
  const textRange: DomInspectorTextRange = {
    end: {
      offset: range.endOffset,
      selector: elementSelector(end, stage),
    },
    start: {
      offset: range.startOffset,
      selector: elementSelector(start, stage),
    },
    textQuote: quote,
  };
  return {
    element,
    item: {
      accessibleName: quote.slice(0, domInspectorContract.maximumAccessibleNameLength),
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      },
      selector: elementSelector(element, stage),
      tagName: element.tagName.toLowerCase(),
      text: quote,
      textRange,
    },
  };
}

const workbenchCss = `
:root {
  color: #111a2b;
  background: #edf2f7;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
button, textarea { font: inherit; }
button { cursor: pointer; }
.oa-shell { min-height: 100vh; display: grid; grid-template-rows: 58px minmax(0, 1fr) 28px; background: #edf2f7; }
.oa-command { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 16px; background: rgba(251, 252, 254, .96); border-bottom: 1px solid #cbd6e4; position: relative; z-index: 20; }
.oa-package { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.oa-package strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; letter-spacing: -.01em; }
.oa-version, .oa-mono { color: #6d7f97; font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.oa-mode-switch { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid #cbd6e4; border-radius: 10px; background: #edf2f7; }
.oa-mode-button { min-width: 70px; padding: 7px 11px; border: 0; border-radius: 7px; background: transparent; color: #60718a; font-size: 12px; font-weight: 720; }
.oa-mode-button[aria-pressed="true"] { background: white; color: #111a2b; box-shadow: 0 1px 4px rgba(17, 26, 43, .14); }
.oa-mode-button:last-child[aria-pressed="true"] { color: #0b67d0; }
.oa-runtime-summary { display: flex; align-items: center; gap: 8px; color: #52657f; font-size: 12px; }
.oa-dot { width: 7px; height: 7px; border-radius: 50%; background: #07886f; box-shadow: 0 0 0 3px rgba(7, 136, 111, .12); }
.oa-main { min-height: 0; display: flex; position: relative; overflow: hidden; }
.oa-context { flex: 0 0 340px; width: 340px; background: #fbfcfe; border-right: 1px solid #cbd6e4; display: flex; flex-direction: column; min-height: 0; position: relative; z-index: 10; }
.oa-context-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #d8e1ec; }
.oa-eyebrow { display: block; color: #6d7f97; font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
.oa-context-header h2 { margin: 3px 0 0; font-size: 16px; }
.oa-icon-button { width: 34px; height: 34px; border-radius: 9px; border: 1px solid #cbd6e4; background: white; color: #52657f; }
.oa-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 8px; background: #edf2f7; border-bottom: 1px solid #d8e1ec; }
.oa-tab { min-width: 0; padding: 9px 6px; border: 0; border-radius: 8px; background: transparent; color: #52657f; font-size: 11px; font-weight: 650; }
.oa-tab[aria-selected="true"] { background: #fff; color: #111a2b; box-shadow: 0 1px 4px rgba(17, 26, 43, .12); }
.oa-panel { padding: 14px; overflow: auto; min-height: 0; }
.oa-empty { margin: 0; padding: 16px; border: 1px dashed #cbd6e4; border-radius: 12px; color: #6d7f97; font-size: 12px; line-height: 1.55; }
.oa-target { padding: 14px; border: 1px solid #e5b765; border-radius: 14px; background: #fff3d8; }
.oa-target-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.oa-target h3 { margin: 9px 0 5px; font-size: 17px; letter-spacing: -.02em; }
.oa-target p { margin: 0; color: #53637a; font-size: 12px; line-height: 1.5; }
.oa-target-fields { display: grid; gap: 6px; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid rgba(181, 107, 0, .24); }
.oa-target-fields div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; color: #6d7f97; font-size: 10px; }
.oa-target-fields dt, .oa-target-fields dd { margin: 0; }
.oa-target-fields dd { overflow-wrap: anywhere; color: #2d3b50; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.oa-provider { color: #b56b00; font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
.oa-form { margin-top: 12px; padding: 12px; border: 1px solid #cbd6e4; border-radius: 14px; background: white; }
.oa-form label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 700; }
.oa-form textarea { width: 100%; min-height: 96px; resize: vertical; padding: 10px; border: 1px solid #cbd6e4; border-radius: 9px; color: #111a2b; background: #fbfcfe; line-height: 1.45; }
.oa-primary { width: 100%; margin-top: 8px; padding: 10px 12px; border: 0; border-radius: 9px; background: #111a2b; color: white; font-weight: 700; }
.oa-primary:disabled { opacity: .45; cursor: not-allowed; }
.oa-list { display: grid; gap: 9px; }
.oa-card { padding: 12px; border: 1px solid #d8e1ec; border-radius: 12px; background: white; }
.oa-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.oa-card strong { font-size: 12px; overflow-wrap: anywhere; }
.oa-card p { margin: 6px 0 0; color: #60718a; font-size: 11px; line-height: 1.45; }
.oa-chip { flex: none; padding: 3px 6px; border-radius: 999px; background: #e5f5f1; color: #06705d; font: 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
.oa-stage { min-width: 0; flex: 1; overflow: auto; background: #edf2f7; }
.oa-stage > * { min-height: 100%; }
.oa-stage.is-inspecting, .oa-stage.is-inspecting * { cursor: crosshair !important; }
.oa-stage [data-oa-inspector-hovered="true"] { outline: 2px dashed #0f73ee !important; outline-offset: 3px !important; }
.oa-stage [data-oa-inspector-selected="true"] { outline: 3px solid #f29a16 !important; outline-offset: 3px !important; box-shadow: 0 0 0 6px rgba(242, 154, 22, .16) !important; }
.oa-inspector-banner { position: absolute; z-index: 28; top: 12px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 8px 12px; border: 1px solid #80b7ff; border-radius: 999px; background: rgba(239, 247, 255, .96); color: #075fc4; box-shadow: 0 8px 24px rgba(15, 115, 238, .14); font-size: 11px; font-weight: 720; white-space: nowrap; pointer-events: none; }
.oa-selection-actions { position: fixed; z-index: 42; display: flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; background: #111a2b; color: white; box-shadow: 0 0 0 1px rgba(17,26,43,.08), 0 14px 32px rgba(17,26,43,.24); transform: translate(-50%, -100%); }
.oa-selection-actions[data-placement="below"] { transform: translate(-50%, 0); }
.oa-selection-actions::after { position: absolute; top: 100%; left: 50%; width: 9px; height: 9px; background: #111a2b; content: ""; transform: translate(-50%, -54%) rotate(45deg); }
.oa-selection-actions[data-placement="below"]::after { top: auto; bottom: 100%; transform: translate(-50%, 54%) rotate(45deg); }
.oa-selection-mark { display: grid; width: 23px; height: 23px; place-items: center; border-radius: 7px; background: #f29a16; font-weight: 850; }
.oa-selection-actions button { min-height: 30px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; font-weight: 760; }
.oa-selection-actions button:hover { background: rgba(255,255,255,.1); }
.oa-selection-actions button:focus-visible { outline: 2px solid #ffd48a; outline-offset: 1px; }
.oa-selection-actions button:disabled { cursor: wait; opacity: .68; }
.oa-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.oa-reopen { position: absolute; left: 0; top: 50%; transform: translateY(-50%); z-index: 30; padding: 10px 14px 10px 10px; border: 1px solid #e5b765; border-left: 0; border-radius: 0 999px 999px 0; background: white; color: #111a2b; box-shadow: 0 12px 30px rgba(17, 26, 43, .16); font-weight: 750; }
.oa-reopen::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: #d98913; }
.oa-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px; border-top: 1px solid #cbd6e4; background: #fbfcfe; color: #6d7f97; font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; }
.oa-status span { overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 780px) {
  .oa-context { position: absolute; inset: 0 auto 0 0; max-width: min(340px, 88vw); box-shadow: 20px 0 50px rgba(17, 26, 43, .18); }
  .oa-runtime-summary .oa-instance-label { display: none; }
  .oa-mode-button { min-width: auto; }
  .oa-inspector-banner { white-space: normal; text-align: center; }
}
`;

function Workbench<TInput>({ Artifact, artifact, input, instanceId, oa }: WorkbenchProps<TInput>) {
  const [contextOpen, setContextOpen] = useState(true);
  const [tab, setTab] = useState<'target' | 'annotations' | 'tools'>('target');
  const [target, setTarget] = useState<TargetSelection>();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'pointer' | 'inspect'>('pointer');
  const [inspectorError, setInspectorError] = useState<string>();
  const [annotationCandidate, setAnnotationCandidate] = useState<AnnotationActionCandidate>();
  const [annotationActionError, setAnnotationActionError] = useState<string>();
  const [openingAnnotation, setOpeningAnnotation] = useState(false);
  const annotationBodyRef = useRef<HTMLTextAreaElement>(null);
  const annotationActionRef = useRef<HTMLButtonElement>(null);
  const annotationToolbarRef = useRef<HTMLDivElement>(null);
  const annotationCandidateRef = useRef<AnnotationActionCandidate | undefined>(undefined);
  const annotationCandidateController = useRef<AbortController | undefined>(undefined);
  const composerFocusFrame = useRef<number | undefined>(undefined);
  const stageRef = useRef<HTMLElement>(null);
  const inspectedElements = useRef<InspectedElement[]>([]);
  const hoveredElement = useRef<Element | undefined>(undefined);
  const inspectorRequest = useRef<{ controller?: AbortController; generation: number }>({
    generation: 0,
  });

  const clearInspectorHighlights = useCallback(() => {
    hoveredElement.current?.removeAttribute('data-oa-inspector-hovered');
    hoveredElement.current = undefined;
    for (const inspected of inspectedElements.current) {
      inspected.element.removeAttribute('data-oa-inspector-selected');
    }
    inspectedElements.current = [];
  }, []);

  const invalidateInspectorRequest = useCallback(() => {
    inspectorRequest.current.controller?.abort();
    inspectorRequest.current = { generation: inspectorRequest.current.generation + 1 };
  }, []);

  const dismissAnnotationCandidate = useCallback((restoreFocus = false) => {
    const current = annotationCandidateRef.current;
    annotationCandidateController.current?.abort();
    annotationCandidateController.current = undefined;
    annotationCandidateRef.current = undefined;
    if (composerFocusFrame.current !== undefined) {
      globalThis.cancelAnimationFrame(composerFocusFrame.current);
      composerFocusFrame.current = undefined;
    }
    setAnnotationCandidate(undefined);
    setAnnotationActionError(undefined);
    setOpeningAnnotation(false);
    if (restoreFocus) current?.focusOrigin.focus();
  }, []);

  useEffect(
    () => () => {
      annotationCandidateController.current?.abort();
      annotationCandidateController.current = undefined;
      annotationCandidateRef.current = undefined;
      if (composerFocusFrame.current !== undefined) {
        globalThis.cancelAnimationFrame(composerFocusFrame.current);
        composerFocusFrame.current = undefined;
      }
    },
    [],
  );

  const openAnnotationCandidate = useCallback(async () => {
    const candidate = annotationCandidateRef.current;
    const controller = annotationCandidateController.current;
    if (!candidate || !controller || openingAnnotation) return;
    setOpeningAnnotation(true);
    setAnnotationActionError(undefined);
    try {
      await candidate.capture(controller.signal);
      if (
        controller.signal.aborted ||
        annotationCandidateRef.current !== candidate ||
        annotationCandidateController.current !== controller
      ) {
        return;
      }
      annotationCandidateRef.current = undefined;
      annotationCandidateController.current = undefined;
      setAnnotationCandidate(undefined);
      setOpeningAnnotation(false);
      composerFocusFrame.current = globalThis.requestAnimationFrame(() => {
        composerFocusFrame.current = undefined;
        annotationBodyRef.current?.focus();
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnnotationActionError(
        error instanceof Error ? error.message : 'Could not prepare this Annotation',
      );
      setOpeningAnnotation(false);
    }
  }, [openingAnnotation]);

  const publishInspectorSelection = useCallback((items: InspectedElement[]) => {
    setInspectorError(undefined);
    inspectorRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = inspectorRequest.current.generation + 1;
    inspectorRequest.current = { controller, generation };
    const selection: DomInspectorSelection = { items: items.map(({ item }) => item) };
    void fetch('__oa/targets/select', {
      body: JSON.stringify({
        provider: domInspectorContract.provider,
        selection,
        trigger: 'selection',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = (await response.json()) as TargetDescriptor<JsonValue, JsonValue> & {
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(value.error?.message ?? 'Could not inspect target');
        }
        if (inspectorRequest.current.generation !== generation) return;
        setTarget({
          descriptor: value,
          provider: domInspectorContract.provider,
          selection: selection as unknown as JsonValue,
        });
        setTab('target');
        setContextOpen(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || inspectorRequest.current.generation !== generation) return;
        setInspectorError(error instanceof Error ? error.message : 'Could not inspect target');
      });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const root = stage.ownerDocument.documentElement;
    if (interactionMode !== 'inspect') {
      root.removeAttribute(domInspectorContract.activeAttribute);
      invalidateInspectorRequest();
      clearInspectorHighlights();
      return;
    }

    root.setAttribute(domInspectorContract.activeAttribute, 'true');
    let suppressClickUntil = 0;
    const clearHover = () => {
      hoveredElement.current?.removeAttribute('data-oa-inspector-hovered');
      hoveredElement.current = undefined;
    };
    const elementFromEvent = (event: Event) => {
      const element = event.target instanceof Element ? event.target : undefined;
      if (!element || element === stage || !stage.contains(element)) return undefined;
      return element;
    };
    const packageTarget = (element: Element) => {
      const owner = element.closest('[data-oa-target-provider]');
      return owner && stage.contains(owner) ? owner : undefined;
    };
    const leaveFallbackForPackage = () => {
      invalidateInspectorRequest();
      clearInspectorHighlights();
    };
    const applyInspectedElement = (candidate: InspectedElement, additive: boolean) => {
      const current = inspectedElements.current;
      const existingIndex = current.findIndex((item) => item.element === candidate.element);
      let next: InspectedElement[];
      if (additive) {
        if (existingIndex >= 0) {
          next = current.filter((_, index) => index !== existingIndex);
        } else {
          if (current.length >= domInspectorContract.maximumItems) {
            setInspectorError(`Select at most ${domInspectorContract.maximumItems} elements`);
            return;
          }
          next = [...current, candidate];
        }
      } else {
        next = [candidate];
      }

      for (const inspected of current) {
        inspected.element.removeAttribute('data-oa-inspector-selected');
      }
      for (const inspected of next) {
        inspected.element.setAttribute('data-oa-inspector-selected', 'true');
      }
      inspectedElements.current = next;
      setContextOpen(true);
      setTab('target');
      if (next.length === 0) {
        invalidateInspectorRequest();
        setTarget(undefined);
        return;
      }
      publishInspectorSelection(next);
    };
    const handlePointerOver = (event: PointerEvent) => {
      const element = elementFromEvent(event);
      if (!element) {
        clearHover();
        return;
      }
      if (packageTarget(element)) {
        clearHover();
        leaveFallbackForPackage();
        return;
      }
      if (hoveredElement.current === element) return;
      clearHover();
      element.setAttribute('data-oa-inspector-hovered', 'true');
      hoveredElement.current = element;
    };
    const handleClick = (event: MouseEvent) => {
      const element = elementFromEvent(event);
      if (!element) return;
      if (packageTarget(element)) {
        leaveFallbackForPackage();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      if ((stage.ownerDocument.defaultView?.performance.now() ?? 0) <= suppressClickUntil) {
        suppressClickUntil = 0;
        return;
      }
      applyInspectedElement(inspectElement(element, stage), event.metaKey || event.ctrlKey);
    };
    const handleMouseUp = (event: MouseEvent) => {
      const element = elementFromEvent(event);
      if (!element) return;
      if (packageTarget(element)) {
        leaveFallbackForPackage();
        return;
      }
      const selection = stage.ownerDocument.getSelection();
      if (!selection) return;
      const inspectedRange = inspectTextRange(selection, stage);
      if (!inspectedRange) return;
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      suppressClickUntil = (stage.ownerDocument.defaultView?.performance.now() ?? 0) + 100;
      applyInspectedElement(inspectedRange, event.metaKey || event.ctrlKey);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      invalidateInspectorRequest();
      setInteractionMode('pointer');
    };

    stage.addEventListener('pointerover', handlePointerOver);
    stage.addEventListener('mouseup', handleMouseUp);
    stage.addEventListener('click', handleClick, true);
    stage.ownerDocument.addEventListener('keydown', handleKeyDown);
    return () => {
      stage.removeEventListener('pointerover', handlePointerOver);
      stage.removeEventListener('mouseup', handleMouseUp);
      stage.removeEventListener('click', handleClick, true);
      stage.ownerDocument.removeEventListener('keydown', handleKeyDown);
      root.removeAttribute(domInspectorContract.activeAttribute);
      invalidateInspectorRequest();
      clearInspectorHighlights();
    };
  }, [
    clearInspectorHighlights,
    interactionMode,
    invalidateInspectorRequest,
    publishInspectorSelection,
  ]);

  useEffect(() => {
    const handleCandidate = (event: Event) => {
      dismissAnnotationCandidate();
      const candidate = (event as CustomEvent<AnnotationActionCandidate>).detail;
      const controller = new AbortController();
      annotationCandidateRef.current = candidate;
      annotationCandidateController.current = controller;
      setAnnotationCandidate(candidate);
      setAnnotationActionError(undefined);
      if (candidate.focusOnShow) {
        composerFocusFrame.current = globalThis.requestAnimationFrame(() => {
          composerFocusFrame.current = undefined;
          annotationActionRef.current?.focus();
        });
      }
    };
    globalThis.addEventListener(annotationActionEvent, handleCandidate);
    return () => globalThis.removeEventListener(annotationActionEvent, handleCandidate);
  }, [dismissAnnotationCandidate]);

  useEffect(() => {
    if (!annotationCandidate) return;
    const document = annotationCandidate.focusOrigin.ownerDocument;
    const closeAndRestore = () => dismissAnnotationCandidate(annotationCandidate.focusOnShow);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && annotationToolbarRef.current?.contains(event.target)) {
        return;
      }
      dismissAnnotationCandidate();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeAndRestore();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('scroll', closeAndRestore, true);
    document.addEventListener('keydown', handleKeyDown);
    globalThis.addEventListener('resize', closeAndRestore);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('scroll', closeAndRestore, true);
      document.removeEventListener('keydown', handleKeyDown);
      globalThis.removeEventListener('resize', closeAndRestore);
    };
  }, [annotationCandidate, dismissAnnotationCandidate]);

  const loadAnnotations = useCallback(async () => {
    const response = await fetch('__oa/annotations');
    if (!response.ok) return;
    const value = (await response.json()) as { annotations: Annotation[] };
    setAnnotations(value.annotations);
  }, []);

  const loadTools = useCallback(async () => {
    const response = await fetch('__oa/tools');
    if (!response.ok) return;
    const value = (await response.json()) as { tools: Tool[] };
    setTools(value.tools);
  }, []);

  useEffect(() => {
    void Promise.all([loadAnnotations(), loadTools()]);
    const handleTarget = (event: Event) => {
      const nextTarget = (event as CustomEvent<TargetSelection>).detail;
      if (nextTarget.provider !== domInspectorContract.provider) {
        invalidateInspectorRequest();
        clearInspectorHighlights();
      }
      setTarget(nextTarget);
      setTab('target');
      setContextOpen(true);
    };
    const handleRuntime = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string }>).detail;
      if (detail.type === 'annotation.created') void loadAnnotations();
    };
    globalThis.addEventListener('oa:target-selected', handleTarget);
    globalThis.addEventListener('oa:runtime-event', handleRuntime);
    return () => {
      globalThis.removeEventListener('oa:target-selected', handleTarget);
      globalThis.removeEventListener('oa:runtime-event', handleRuntime);
    };
  }, [clearInspectorHighlights, invalidateInspectorRequest, loadAnnotations, loadTools]);

  const createAnnotation = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || !body.trim()) return;
    setSubmitting(true);
    try {
      const response = await fetch('__oa/annotations', {
        body: JSON.stringify({
          actor: { id: 'workbench', type: 'human' },
          body: body.trim(),
          provider: target.provider,
          selection: target.selection,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) throw new Error('Could not create Annotation');
      setBody('');
      await loadAnnotations();
      setTab('annotations');
    } finally {
      setSubmitting(false);
    }
  };

  const panel = useMemo(() => {
    if (tab === 'tools') {
      if (tools.length === 0)
        return <p className="oa-empty">This Package has no Artifact Tools.</p>;
      return (
        <div className="oa-list">
          {tools.map((tool) => (
            <article className="oa-card" key={tool.name}>
              <div className="oa-card-top">
                <strong>{tool.name}</strong>
                <span className="oa-chip">{tool.effects.data}</span>
              </div>
              <p>{tool.description}</p>
            </article>
          ))}
        </div>
      );
    }
    if (tab === 'annotations') {
      if (annotations.length === 0) {
        return (
          <p className="oa-empty">Select content in the Artifact UI, then leave an Annotation.</p>
        );
      }
      return (
        <div className="oa-list">
          {annotations.map((annotation) => (
            <article className="oa-card" key={annotation.id}>
              <div className="oa-card-top">
                <strong>{annotation.targetSnapshot.presentation.title}</strong>
                <span className="oa-chip">{annotation.status}</span>
              </div>
              <p>{annotation.body}</p>
            </article>
          ))}
        </div>
      );
    }
    if (!target) {
      return (
        <p className="oa-empty">
          Select a Package-defined target. In the Markdown Editor, drag across preview text; in the
          Video Editor, select a clip or marked range.
        </p>
      );
    }
    return (
      <>
        <article className="oa-target">
          <div className="oa-target-head">
            <span className="oa-provider">{target.provider}</span>
            <span className="oa-chip">current target</span>
          </div>
          <h3>{target.descriptor.presentation.title}</h3>
          {target.descriptor.presentation.summary ? (
            <p>{target.descriptor.presentation.summary}</p>
          ) : null}
          {target.descriptor.presentation.fields?.length ? (
            <dl className="oa-target-fields">
              {target.descriptor.presentation.fields.map((field) => (
                <div key={`${field.label}:${field.value}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </article>
        <form className="oa-form" onSubmit={createAnnotation}>
          <label htmlFor="oa-annotation-body">Tell an Agent what matters here</label>
          <textarea
            id="oa-annotation-body"
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder="Describe the change or question…"
            ref={annotationBodyRef}
            value={body}
          />
          <button className="oa-primary" disabled={submitting || !body.trim()} type="submit">
            {submitting ? 'Saving…' : 'Create annotation'}
          </button>
        </form>
      </>
    );
  }, [annotations, body, submitting, tab, target, tools]);

  return (
    <div className="oa-shell">
      <style>{workbenchCss}</style>
      <header className="oa-command">
        <div className="oa-package">
          <strong>{artifact.name}</strong>
          <span className="oa-version">{artifact.version}</span>
        </div>
        <div aria-label="Interaction mode" className="oa-mode-switch" role="group">
          <button
            aria-pressed={interactionMode === 'pointer'}
            className="oa-mode-button"
            onClick={() => setInteractionMode('pointer')}
            type="button"
          >
            Pointer
          </button>
          <button
            aria-pressed={interactionMode === 'inspect'}
            className="oa-mode-button"
            onClick={() => {
              setInspectorError(undefined);
              setInteractionMode('inspect');
              setContextOpen(true);
            }}
            type="button"
          >
            Inspect
          </button>
        </div>
      </header>
      <main className="oa-main">
        {interactionMode === 'inspect' ? (
          <div aria-live="polite" className="oa-inspector-banner">
            {inspectorError ??
              'Inspector active · Click to select · Cmd/Ctrl + click to multi-select · Esc to exit'}
          </div>
        ) : null}
        <span aria-live="polite" className="oa-sr-only">
          {annotationCandidate
            ? (annotationActionError ?? 'Text selected. Add an annotation.')
            : ''}
        </span>
        {annotationCandidate ? (
          <div
            aria-label="Text selection actions"
            className="oa-selection-actions"
            data-placement={annotationCandidate.anchor.placement}
            ref={annotationToolbarRef}
            role="toolbar"
            style={{
              left: `${annotationCandidate.anchor.left}px`,
              top: `${annotationCandidate.anchor.top}px`,
            }}
            title={annotationActionError}
          >
            <span aria-hidden="true" className="oa-selection-mark">
              +
            </span>
            <button
              disabled={openingAnnotation}
              onClick={() => void openAnnotationCandidate()}
              onMouseDown={(event) => event.preventDefault()}
              ref={annotationActionRef}
              type="button"
            >
              {openingAnnotation
                ? 'Opening…'
                : annotationActionError
                  ? 'Try again'
                  : 'Add annotation'}
            </button>
          </div>
        ) : null}
        {contextOpen ? (
          <aside className="oa-context">
            <header className="oa-context-header">
              <div>
                <span className="oa-eyebrow">Human context</span>
                <h2>Context</h2>
              </div>
              <button
                aria-label="Collapse Context"
                className="oa-icon-button"
                onClick={() => setContextOpen(false)}
                type="button"
              >
                ‹
              </button>
            </header>
            <nav aria-label="Context views" className="oa-tabs">
              <button
                aria-selected={tab === 'target'}
                className="oa-tab"
                onClick={() => setTab('target')}
                role="tab"
                type="button"
              >
                Target
              </button>
              <button
                aria-selected={tab === 'annotations'}
                className="oa-tab"
                onClick={() => setTab('annotations')}
                role="tab"
                type="button"
              >
                Annotations · {annotations.length}
              </button>
              <button
                aria-selected={tab === 'tools'}
                className="oa-tab"
                onClick={() => setTab('tools')}
                role="tab"
                type="button"
              >
                Tools · {tools.length}
              </button>
            </nav>
            <section className="oa-panel">{panel}</section>
          </aside>
        ) : (
          <button className="oa-reopen" onClick={() => setContextOpen(true)} type="button">
            Context
          </button>
        )}
        <section
          className={`oa-stage${interactionMode === 'inspect' ? ' is-inspecting' : ''}`}
          ref={stageRef}
        >
          <Artifact data={input} input={input} oa={oa} />
        </section>
      </main>
      <footer className="oa-status">
        <span>
          <span className="oa-dot" /> Active · Data synced · {tools.length} Tools ·{' '}
          {annotations.length} Annotations
        </span>
        <span className="oa-mono">Instance {instanceId.slice(0, 8)} · Instance-scoped SDK</span>
      </footer>
    </div>
  );
}

function runtimeSubscription(listener: (event: RuntimeEvent) => void) {
  const source = new EventSource('__oa/events');
  source.onmessage = (event) => {
    const detail = JSON.parse(event.data) as RuntimeEvent;
    listener(detail);
    globalThis.dispatchEvent(new CustomEvent('oa:runtime-event', { detail }));
  };
  return () => source.close();
}

async function installWebMcpAdapter() {
  const modelContext = (
    document as Document & {
      modelContext?: {
        registerTool(definition: Record<string, unknown>): Promise<void> | void;
      };
    }
  ).modelContext;
  if (!modelContext) return;
  const response = await fetch('__oa/tools').catch(() => undefined);
  if (!response?.ok) return;
  const payload = (await response.json().catch(() => undefined)) as
    { revision?: string; tools?: Tool[] } | undefined;
  if (!Array.isArray(payload?.tools) || typeof payload.revision !== 'string') return;
  let observedRevision = payload.revision;
  await Promise.allSettled(
    payload.tools.map((tool) =>
      modelContext.registerTool({
        annotations: { readOnlyHint: tool.effects.data !== 'write' },
        description: tool.description,
        execute: async (input: JsonValue) => {
          const result = await fetch('__oa/tools/call', {
            body: JSON.stringify({
              ...(tool.effects.data === 'write' ? { baseRevision: observedRevision } : {}),
              idempotencyKey: crypto.randomUUID(),
              input,
              name: tool.name,
            }),
            headers: {
              'content-type': 'application/json',
              'x-oa-adapter': 'webmcp',
            },
            method: 'POST',
          });
          const output = (await result.json()) as {
            error?: { code?: string; message?: string };
            revision?: string;
          };
          if (!result.ok) {
            const error = new Error(output.error?.message ?? `Tool Call failed (${result.status})`);
            error.name = output.error?.code ?? 'TOOL_CALL_FAILED';
            throw error;
          }
          if (typeof output.revision === 'string') observedRevision = output.revision;
          return output;
        },
        inputSchema: (tool as Tool & { inputSchema?: unknown }).inputSchema,
        name: tool.name,
        title: tool.title,
      }),
    ),
  );
}

export function mountArtifactWorkbench<TInput>(options: {
  Artifact: ComponentType<ArtifactRenderProps<TInput> & { data?: TInput }>;
  artifact: ArtifactMeta;
  input: TInput;
  instanceId: string;
  root: HTMLElement;
}) {
  const client = createOaBrowserClient({
    baseUrl: globalThis.location.href,
    subscribe: runtimeSubscription,
  });
  createRoot(options.root).render(
    createElement(Workbench<TInput>, {
      ...options,
      oa: client,
    }),
  );
  void installWebMcpAdapter().catch(() => undefined);
  return () => client.dispose();
}
