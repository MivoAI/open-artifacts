import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { HTMLAttributes, MouseEvent as ReactMouseEvent } from 'react';

import {
  domInspectorContract,
  type DataBinding,
  type OaSdk,
  type TargetDescriptor,
  type TargetInteraction,
} from './index.js';

export const annotationActionEvent = 'oa:annotation-action-candidate';

export interface AnnotationActionAnchor {
  left: number;
  placement: 'above' | 'below';
  top: number;
}

export interface AnnotationActionCandidate {
  anchor: AnnotationActionAnchor;
  capture(signal: AbortSignal): Promise<void>;
  focusOnShow: boolean;
  focusOrigin: HTMLElement;
}

export function useDataBinding<T>(binding: DataBinding<T>) {
  return useSyncExternalStore(
    (listener) => binding.subscribe(listener),
    () => binding.getSnapshot(),
    () => binding.getSnapshot(),
  );
}

export function useAnnotationTarget<TSelection, TSelector, TContext>(options: {
  oa: OaSdk;
  provider: string;
  selection: TSelection;
}): {
  props: HTMLAttributes<HTMLElement> & {
    'data-oa-target-provider': string;
  };
  select(
    selectionOverride?: TSelection,
    trigger?: TargetInteraction,
    signal?: AbortSignal,
  ): Promise<TargetDescriptor<TSelector, TContext>>;
  requestAnnotation(request: {
    anchor: AnnotationActionAnchor;
    beforeCapture?(signal: AbortSignal): Promise<void>;
    focusOnShow?: boolean;
    focusOrigin: HTMLElement;
    selection?: TSelection;
  }): void;
} {
  const select = useCallback(
    (
      selectionOverride?: TSelection,
      trigger: TargetInteraction = 'selection',
      signal?: AbortSignal,
    ) =>
      options.oa.annotation.select<TSelection, TSelector, TContext>({
        provider: options.provider,
        selection: selectionOverride ?? options.selection,
        ...(signal === undefined ? {} : { signal }),
        trigger,
      }),
    [options.oa, options.provider, options.selection],
  );

  const requestAnnotation = useCallback(
    (request: {
      anchor: AnnotationActionAnchor;
      beforeCapture?(signal: AbortSignal): Promise<void>;
      focusOnShow?: boolean;
      focusOrigin: HTMLElement;
      selection?: TSelection;
    }) => {
      const selection = request.selection ?? options.selection;
      const candidate: AnnotationActionCandidate = {
        anchor: request.anchor,
        capture: async (signal) => {
          if (signal.aborted) return;
          await request.beforeCapture?.(signal);
          if (signal.aborted) return;
          await select(selection, 'capture', signal);
        },
        focusOnShow: request.focusOnShow ?? false,
        focusOrigin: request.focusOrigin,
      };
      globalThis.dispatchEvent(new CustomEvent(annotationActionEvent, { detail: candidate }));
    },
    [options.selection, select],
  );

  const props = useMemo(
    () => ({
      'data-oa-target-provider': options.provider,
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (
          !event.currentTarget.ownerDocument.documentElement.hasAttribute(
            domInspectorContract.activeAttribute,
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void select(undefined, 'selection');
      },
      onContextMenu: () => void select(undefined, 'context-menu'),
      onMouseEnter: () => void select(undefined, 'hover'),
    }),
    [options.provider, select],
  );

  return { props, requestAnnotation, select };
}
