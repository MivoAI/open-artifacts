import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

import type { DecisionBoardInput } from './model.ts';

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

interface TrendChartProps {
  metrics: DecisionBoardInput['metrics'];
}

export function TrendChart({ metrics }: TrendChartProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!root.current) return;

    const chart = echarts.init(root.current, undefined, { renderer: 'svg' });
    const maximumSamples = Math.max(...metrics.map((metric) => metric.trend.length));

    chart.setOption({
      animationDuration: 420,
      color: ['#315be8', '#00a28a', '#f07a45', '#8c5de8'],
      grid: { left: 2, right: 3, top: 20, bottom: 4 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#182433',
        borderWidth: 0,
        textStyle: { color: '#ffffff', fontFamily: 'SFMono-Regular, monospace', fontSize: 10 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: Array.from({ length: maximumSamples }, (_, index) => `v${index + 1}`),
        show: false,
      },
      yAxis: { type: 'value', show: false },
      series: metrics.map((metric) => ({
        name: metric.label,
        type: 'line',
        data: metric.trend,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: { width: 2.25 },
      })),
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(root.current);

    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [metrics]);

  return (
    <div className="db-trend-chart" ref={root} aria-label="Artifact Package contract trends" />
  );
}
