import { useLocalize } from '~/hooks';

export default function Brand({ compact = false }: { compact?: boolean }) {
  const localize = useLocalize();
  return (
    <div className="w-fit max-w-full rounded-md bg-surface-fixed px-3 py-2">
      <img
        src="assets/branding/brreg-logo.svg"
        alt={localize('com_ui_logo', { 0: 'Brønnøysundregistrene' })}
        width={300}
        height={37}
        className={compact ? 'h-auto w-44 max-w-full' : 'h-auto w-60 max-w-full'}
      />
    </div>
  );
}
