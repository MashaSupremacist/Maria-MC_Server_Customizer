import { type Edition, type PageId } from '@msc/shared-types';

export interface NavItem {
  id: string;
  label: string;
  page: PageId;
}

interface SidebarProps {
  edition: Edition;
  nav: NavItem[];
  activePage: string;
  onEditionChange: (edition: Edition) => void;
  onNavigate: (page: string) => void;
}

export default function Sidebar({
  edition,
  nav,
  activePage,
  onEditionChange,
  onNavigate,
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="edition-switch" role="tablist" aria-label="Server edition">
        <button
          type="button"
          role="tab"
          aria-selected={edition === 'java'}
          className={`edition-button${edition === 'java' ? ' active' : ''}`}
          onClick={() => onEditionChange('java')}
        >
          Java
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={edition === 'bedrock'}
          className={`edition-button${edition === 'bedrock' ? ' active' : ''}`}
          onClick={() => onEditionChange('bedrock')}
        >
          Bedrock
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item${activePage === item.page ? ' active' : ''}`}
            onClick={() => onNavigate(item.page)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className="muted">No server selected</span>
      </div>
    </aside>
  );
}
