import type { SelectHTMLAttributes } from 'react';
import { PopupIcon } from './PopupIcon';

export function FilterSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="filter-select"><select {...props} /><PopupIcon name="chevron" /></span>;
}
