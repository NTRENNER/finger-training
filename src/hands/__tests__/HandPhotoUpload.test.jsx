import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HandPhotoUpload } from '../HandPhotoUpload.jsx';

const photo = (name, size = 3_000_000) => new File([new Uint8Array(1)], name, { type: '' });

test('without an upload folder it shows the instructions and why upload is unavailable', () => {
  render(<HandPhotoUpload client={null} prefix={null} blockedMessage="Sign in under Cloud Sync to upload your photos." />);
  expect(screen.getByText(/two small marks on each/)).toBeInTheDocument();
  expect(screen.getByText('Sign in under Cloud Sync to upload your photos.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload photos' })).toBeNull();
});

test('uploads both photos into the given folder', async () => {
  const upload = jest.fn().mockResolvedValue({ error: null });
  const client = { storage: { from: () => ({ upload }) } };
  render(<HandPhotoUpload client={client} prefix="u/uid-1" />);
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nathan Renner' } });
  const big = name => Object.defineProperty(photo(name), 'size', { value: 3_000_000 });
  fireEvent.change(screen.getByLabelText('Photo 1: fingers together'), { target: { files: [big('IMG_1.HEIC')] } });
  fireEvent.change(screen.getByLabelText(/Photo 2: fingers slightly apart/), { target: { files: [big('IMG_2.HEIC')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload photos' }));
  expect(await screen.findByText('Thank you! Both photos arrived.')).toBeInTheDocument();
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[0][0]).toMatch(/^u\/uid-1\/\d{4}-\d{2}-\d{2}_nathan-renner\/together_/);
});

test('a screenshot-sized file is refused before uploading', () => {
  const upload = jest.fn();
  render(<HandPhotoUpload client={{ storage: { from: () => ({ upload }) } }} prefix="abc123XYZ9" />);
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sandy' } });
  fireEvent.change(screen.getByLabelText('Photo 1: fingers together'), { target: { files: [photo('shot.png')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload photos' }));
  expect(screen.getByText(/too small to be an original/)).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
});
