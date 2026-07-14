import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { VARIANTS } from './model.ts';
import type { ArtifactMetric, VariantKey } from './model.ts';

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

interface ArtifactTargetProps {
  path: string;
  label: string;
  className?: string;
  children: ReactNode;
}

export function ArtifactTarget({ path, label, className, children }: ArtifactTargetProps) {
  const classes = ['artifact-target', className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-artifact-label={label}
      data-artifact-path={path}
      role="button"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

interface TrendChartProps {
  metrics: ArtifactMetric[];
}

export function TrendChart({ metrics }: TrendChartProps) {
  const chartRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartRoot.current) return;

    const chart = echarts.init(chartRoot.current, undefined, { renderer: 'svg' });
    chart.setOption({
      animationDuration: 500,
      color: ['#2c5be6', '#a749f5', '#0b8f73', '#df6a3e'],
      grid: { left: 4, right: 4, top: 16, bottom: 6, containLabel: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#17212b',
        borderWidth: 0,
        textStyle: { color: '#fbfcfe', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: ['v1', 'v2', 'v3', 'v4', 'v5', 'now'],
        show: false,
      },
      yAxis: { type: 'value', show: false },
      series: metrics.map((metric) => ({
        name: metric.label,
        type: 'line',
        data: metric.trend,
        showSymbol: false,
        smooth: 0.28,
        lineStyle: { width: 2 },
      })),
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(chartRoot.current);

    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [metrics]);

  return <div className="trend-chart" ref={chartRoot} aria-label="指标变化趋势图" />;
}

interface PrototypeSwitcherProps {
  current: VariantKey;
  onChange: (variant: VariantKey) => void;
}

export function PrototypeSwitcher({ current, onChange }: PrototypeSwitcherProps) {
  const currentIndex = VARIANTS.findIndex((variant) => variant.key === current);

  function cycle(offset: number) {
    const nextIndex = (currentIndex + offset + VARIANTS.length) % VARIANTS.length;
    const next = VARIANTS[nextIndex];
    if (next) onChange(next.key);
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, [contenteditable="true"]') || target.isContentEditable)
      ) {
        return;
      }

      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  if (import.meta.env.PROD) return null;

  const active = VARIANTS[currentIndex] ?? VARIANTS[0];

  return (
    <nav className="prototype-switcher" aria-label="原型版式切换">
      <button type="button" onClick={() => cycle(-1)} aria-label="上一个版式">
        ←
      </button>
      <div>
        <strong>{active.label}</strong>
        <span>{active.description}</span>
      </div>
      <button type="button" onClick={() => cycle(1)} aria-label="下一个版式">
        →
      </button>
    </nav>
  );
}
