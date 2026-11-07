import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'ghost' | 'plain' | 'filled' | 'surface' | 'overlay';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Icon-only buttons need a spoken name. */
  'aria-label': string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  ghost: 'text-white/70 hover:bg-white/10 hover:text-white',
  plain: 'text-white hover:bg-white/10',
  overlay: 'bg-black/60 text-white hover:bg-nf-raised',
  filled: 'bg-white/10 text-white hover:bg-white/20',
  surface: 'bg-nf-surface text-white hover:bg-nf-raised',
};

const SIZES: Record<Size, string> = { sm: 'h-8 w-8', md: 'h-9 w-9', lg: 'h-10 w-10' };

/** Round icon-only button. */
const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { variant = 'ghost', size = 'md', className = '', type = 'button', title, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={title ?? rest['aria-label']}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export default IconButton;
