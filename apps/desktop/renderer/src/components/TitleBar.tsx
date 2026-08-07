interface TitleBarProps {
  appName: string;
}

export default function TitleBar({ appName }: TitleBarProps): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-title">{appName}</div>
      <div className="titlebar-controls">
        <button
          type="button"
          aria-label="Minimize window"
          className="titlebar-button"
          onClick={() => window.msc.minimizeWindow()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Maximize or restore window"
          className="titlebar-button"
          onClick={() => window.msc.toggleMaximizeWindow()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Close window"
          className="titlebar-button titlebar-button-close"
          onClick={() => window.msc.closeWindow()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  );
}
