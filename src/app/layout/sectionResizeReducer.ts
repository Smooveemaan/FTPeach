export type ResizableSection = 'transfers' | 'log';
export interface SectionResizeState {
  activeSection: ResizableSection | null;
  transferManuallyResized: boolean;
  logManuallyResized: boolean;
}
export type SectionResizeAction =
  { type: 'start' | 'touch'; section: ResizableSection } | { type: 'stop' };

export const initialSectionResizeState: SectionResizeState = {
  activeSection: null,
  transferManuallyResized: false,
  logManuallyResized: false,
};

export function sectionResizeReducer(
  state: SectionResizeState,
  action: SectionResizeAction,
): SectionResizeState {
  switch (action.type) {
    case 'start':
      return { ...state, activeSection: action.section };
    case 'touch':
      return action.section === 'transfers'
        ? { ...state, transferManuallyResized: true }
        : { ...state, logManuallyResized: true };
    case 'stop':
      return { ...state, activeSection: null };
    default:
      return state;
  }
}
