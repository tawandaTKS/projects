import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue, type ChartSpec, type QueryResult } from '@pada/core';

// Categorical slots in fixed order (validated light/dark palette); values come from CSS tokens.
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

const compact = (v: unknown) =>
  typeof v === 'number' ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : String(v ?? '');

const shortLabel = (v: unknown) => {
  const s = String(v ?? '');
  if (/^\d{4}-\d{2}-\d{2}( 00:00:00)?$/.test(s)) return s.slice(0, 10).endsWith('-01') ? s.slice(0, 7) : s.slice(0, 10);
  return s.length > 16 ? s.slice(0, 15) + '…' : s;
};

const axis = { stroke: 'var(--chart-axis)', tick: { fill: 'var(--text-muted)', fontSize: 12 }, tickLine: false };
const tooltipProps = {
  contentStyle: { background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 13 },
  labelStyle: { color: 'var(--text)', fontWeight: 600 },
  itemStyle: { color: 'var(--text-secondary)' },
  formatter: (v: unknown) => formatValue(v),
  labelFormatter: (l: unknown) => shortLabel(l),
};

export function Chart({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  if (spec.type === 'none' || !spec.x || !spec.y?.length) return null;
  const x = spec.x;
  const ys = spec.y;
  const data = result.rows.slice(0, 1000);
  const legend = ys.length >= 2 ? <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} iconType="circle" /> : null;
  const grid = <CartesianGrid stroke="var(--chart-grid)" vertical={false} />;

  let chart: React.ReactElement;
  if (spec.type === 'line') {
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        {grid}
        <XAxis dataKey={x} {...axis} tickFormatter={shortLabel} minTickGap={24} />
        <YAxis {...axis} axisLine={false} tickFormatter={compact} width={56} />
        <Tooltip {...tooltipProps} cursor={{ stroke: 'var(--chart-axis)' }} />
        {legend}
        {ys.map((y, i) => (
          <Line key={y} type="monotone" dataKey={y} stroke={SERIES[i]} strokeWidth={2} dot={data.length <= 24 ? { r: 4, strokeWidth: 2, fill: 'var(--surface)' } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
        ))}
      </LineChart>
    );
  } else if (spec.type === 'pie') {
    chart = (
      <PieChart>
        <Tooltip {...tooltipProps} />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} iconType="circle" formatter={(v) => shortLabel(v)} />
        <Pie data={data} dataKey={ys[0]} nameKey={x} innerRadius="55%" outerRadius="85%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={`var(--series-${(i % 8) + 1})`} />
          ))}
        </Pie>
      </PieChart>
    );
  } else if (spec.type === 'scatter') {
    chart = (
      <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="var(--chart-grid)" />
        <XAxis dataKey={x} type="number" name={x} {...axis} tickFormatter={compact} />
        <YAxis dataKey={ys[0]} type="number" name={ys[0]} {...axis} axisLine={false} tickFormatter={compact} width={56} />
        <Tooltip {...tooltipProps} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={data} fill={SERIES[0]} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false} />
      </ScatterChart>
    );
  } else {
    chart = (
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }} barCategoryGap="20%" barGap={2}>
        {grid}
        <XAxis dataKey={x} {...axis} tickFormatter={shortLabel} interval="preserveStartEnd" minTickGap={8} />
        <YAxis {...axis} axisLine={false} tickFormatter={compact} width={56} />
        <Tooltip {...tooltipProps} cursor={{ fill: 'var(--chart-hover)' }} />
        {legend}
        {ys.map((y, i) => (
          <Bar key={y} dataKey={y} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  }

  return (
    <div className="chart" role="img" aria-label={`${spec.type} chart of ${ys.join(', ')} by ${x}`}>
      <ResponsiveContainer width="100%" height={280}>
        {chart}
      </ResponsiveContainer>
    </div>
  );
}
