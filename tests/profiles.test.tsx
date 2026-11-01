import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProfileGate from '../src/components/profiles/ProfileGate';
import * as db from '../src/services/db';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { Profile } from '../src/types/media';

vi.mock('../src/services/db');
afterEach(cleanup);

it('saves bedtime and wake time using the shared app dropdowns', async () => {
  const profile: Profile = { id: 1, name: 'Test profile', color: '#E50914', maturity: 'all', created_at: '2026-10-01', daily_limit: 0, bedtime: '', wake_time: '07:00', pin: '' };
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ profiles: [profile], profileGate: 'manage' });
  vi.mocked(db.listProfiles).mockResolvedValue([profile]);
  render(<ProfileGate />);
  fireEvent.click(screen.getByRole('button', { name: 'Test profile' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Bedtime' }));
  fireEvent.click(screen.getByRole('option', { name: '20:30' }));
  fireEvent.click(screen.getByRole('button', { name: 'Wake time' }));
  fireEvent.click(screen.getByRole('option', { name: '07:30' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(db.updateProfile).toHaveBeenCalledWith(1, expect.objectContaining({ bedtime: '20:30', wake_time: '07:30' })));
});
