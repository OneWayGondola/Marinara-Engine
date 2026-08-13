import { X } from "lucide-react";
import {
  inventoryItemTrackerLockPrefix,
  inventoryTrackerLockKey,
  isTrackerFieldLocked,
  renameTrackerFieldLockPrefix,
  type InventoryItem,
} from "@marinara-engine/shared";
import { cn } from "../../../../lib/utils";
import { visibleText } from "../../lib/tracker-display";
import { InlineEdit, InlineNumber } from "../controls/InlineControls";
import { useTrackerLockContext } from "../TrackerLockContext";
import { useTranslation as useUiTranslation } from "react-i18next";

export function PersonaInventoryRow({
  item,
  itemIndex,
  onUpdate,
  onRemove,
  deleteMode,
  fullWidth = false,
}: {
  item: InventoryItem;
  itemIndex: number;
  onUpdate: (item: InventoryItem) => void;
  onRemove: () => void;
  deleteMode: boolean;
  fullWidth?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { fieldLocks, lockMode, onToggleFieldLock, onUpdateFieldLocks } = useTrackerLockContext();
  const nameLockKey = inventoryTrackerLockKey(item, "name", itemIndex);
  const quantityLockKey = inventoryTrackerLockKey(item, "quantity", itemIndex);
  const isStored = typeof item.location === "string" && item.location.trim().length > 0 && item.location !== "on_person";
  const locationLabel = isStored ? item.location : null;
  const detailParts = [item.description?.trim(), locationLabel ? `(${locationLabel})` : null].filter(Boolean);
  const detailTitle = detailParts.length > 0 ? detailParts.join(" ") : visibleText(item.name, "Item");
  const updateName = (name: string) => {
    const nextItem = { ...item, name: name || "Item" };
    if (nextItem.name !== item.name) {
      onUpdateFieldLocks?.((locks) =>
        renameTrackerFieldLockPrefix(
          locks,
          inventoryItemTrackerLockPrefix(item, itemIndex),
          inventoryItemTrackerLockPrefix(nextItem, itemIndex),
        ),
      );
    }
    onUpdate(nextItem);
  };
  return (
    <div
      title={detailTitle}
      className={cn(
        "relative min-w-0 rounded-[2px] border border-[var(--tracker-profile-slot-rule)] bg-[image:var(--tracker-profile-slot-surface)] px-1 py-px shadow-[inset_0_1px_2px_var(--tracker-profile-slot-shadow)] [background-blend-mode:var(--tracker-profile-slot-surface-blend)]",
        fullWidth && "col-span-full",
        deleteMode && "pr-5",
      )}
    >
      <div className="grid min-h-4 grid-cols-[minmax(0,1fr)_max-content] items-center gap-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <InlineEdit
            value={item.name}
            onSave={updateName}
            className="h-4 w-full min-w-0 px-0.5 py-0 text-[0.625rem] font-medium leading-4 text-[color:var(--tracker-profile-text)] hover:bg-[var(--accent)]/25"
            placeholder={localizeUi("ui.trackerPanel.personainventoryrow.item")}
            title={visibleText(item.name, "Item")}
            scrollOnHover
            showEditHint={false}
            locked={isTrackerFieldLocked(fieldLocks, nameLockKey)}
            lockMode={lockMode}
            onToggleLock={() => onToggleFieldLock?.(nameLockKey)}
          />
          {locationLabel && (
            <span
              className="shrink-0 rounded-[2px] bg-[var(--tracker-profile-slot-rule)]/40 px-1 text-[0.5rem] leading-3 text-[color:var(--tracker-profile-text)]/70"
              title={locationLabel}
            >
              {localizeUi("ui.trackerPanel.personainventoryrow.stored")}
            </span>
          )}
        </div>
        <div className="flex h-4 min-w-0 items-center justify-end">
          <InlineNumber
            value={item.quantity}
            onChange={(quantity) => onUpdate({ ...item, quantity })}
            min={0}
            className="justify-self-end px-0 text-right text-[0.625rem] leading-4 text-[color:var(--tracker-profile-number-text)] hover:bg-transparent focus:bg-transparent focus:ring-0"
            title={localizeUi("ui.trackerPanel.personainventoryrow.value1Quantity", { value1: item.name })}
            locked={isTrackerFieldLocked(fieldLocks, quantityLockKey)}
            lockMode={lockMode}
            onToggleLock={() => onToggleFieldLock?.(quantityLockKey)}
          />
        </div>
      </div>
      {deleteMode && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-0.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
          title={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: item.name })}
          aria-label={localizeUi("ui.trackerPanel.charactertrackercard.removeValue1", { value1: item.name })}
        >
          <X size="0.65rem" />
        </button>
      )}
    </div>
  );
}
