'use client';
import { Badge } from '@/components/ui/badge';

interface Props {
  level: 'high' | 'medium' | 'low';
  value?: number;
}

export function ConfidenceBadge({ level, value }: Props) {
  const config = {
    high: { label: 'High', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
    medium: { label: 'Med', className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
    low: { label: 'Low', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  }[level];

  return (
    <Badge variant="outline" className={`text-xs ${config.className}`}>
      {config.label}{value !== undefined ? ` ${Math.round(value * 100)}%` : ''}
    </Badge>
  );
}
