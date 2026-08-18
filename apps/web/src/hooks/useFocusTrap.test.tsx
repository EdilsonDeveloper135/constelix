import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useFocusTrap } from "./useFocusTrap";

function Dialog({
  open,
  onClose,
  useInitialFocus = false,
}: {
  open: boolean;
  onClose: () => void;
  useInitialFocus?: boolean;
}) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    open,
    onClose,
    ...(useInitialFocus ? { initialFocusRef } : {}),
  });
  if (!open) return null;
  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      role="dialog"
      data-testid="dialog"
    >
      <button>First</button>
      <button ref={initialFocusRef}>Middle</button>
      <button>Last</button>
    </div>
  );
}

function Harness({ useInitialFocus = false }: { useInitialFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open trigger</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        useInitialFocus={useInitialFocus}
      />
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses the container by default when the dialog opens", async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByText("Open trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("dialog")).toHaveFocus();
    });
  });

  it("focuses the given initialFocusRef instead of the container", async () => {
    render(<Harness useInitialFocus />);
    await userEvent.setup().click(screen.getByText("Open trigger"));
    await waitFor(() => {
      expect(screen.getByText("Middle")).toHaveFocus();
    });
  });

  it("calls onClose on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open trigger"));
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
    });
  });

  it("wraps Tab from the last focusable element back to the first", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open trigger"));
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveFocus());

    screen.getByText("Last").focus();
    await user.tab();
    expect(screen.getByText("First")).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable element back to the last", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Open trigger"));
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveFocus());

    screen.getByText("First").focus();
    await user.tab({ shift: true });
    expect(screen.getByText("Last")).toHaveFocus();
  });

  it("returns focus to the trigger that opened the dialog once it closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByText("Open trigger");
    await user.click(trigger);
    await waitFor(() => expect(screen.getByTestId("dialog")).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
