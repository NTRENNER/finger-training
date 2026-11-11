import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WarmupView } from '../WarmupView.jsx';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => localStorage.clear());

test('missing body weight can be entered and saved without leaving warm-up', async () => {
  const save = jest.fn();
  function Harness() {
    const [bodyWeightKg, setWeight] = useState(null);
    return <WarmupView history={[]} bodyWeightKg={bodyWeightKg} unit="kg" tindeq={{ connected: false }}
      onClose={() => {}} onBwSave={(kg, date) => { save(kg, date); setWeight(kg); }} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Add body weight' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Weight (kg)' }), { target: { value: '70' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(70, expect.any(String)));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add body weight' })).not.toBeInTheDocument();
});
