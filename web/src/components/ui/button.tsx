import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow,background-color,border-color] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: 'bg-primary/80 backdrop-blur-glass border border-primary/35 text-primary-foreground hover:bg-primary/95 glass-specular',
        destructive: 'bg-destructive/75 backdrop-blur-glass border border-destructive/30 text-destructive-foreground hover:bg-destructive/90 glass-specular',
        outline: 'bg-glass backdrop-blur-glass border border-border hover:bg-secondary/70 glass-specular',
        secondary: 'bg-secondary/65 backdrop-blur-glass border border-border text-secondary-foreground hover:bg-secondary/85 glass-specular',
        ghost: 'border border-transparent hover:bg-glass hover:backdrop-blur-glass hover:border-border hover:text-accent-foreground',
        link: 'text-foreground font-medium underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof buttonVariants>, 'variant'> {
  /** bare：不带按钮配方，外观完全由 className 决定（图卡、列表行、画布工具等自定义表面） */
  variant?: VariantProps<typeof buttonVariants>['variant'] | 'bare';
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    const classes = variant === 'bare' ? className : cn(buttonVariants({ variant, size, className }));
    return <Comp className={classes} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
