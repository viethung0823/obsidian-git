import type { App } from "obsidian";
import { Modal } from "obsidian";
import type { RotationPlan } from "../../rotationManager";

export class RotationModal extends Modal {
    resolve: ((value: boolean) => void) | null = null;

    constructor(
        app: App,
        private readonly plan: RotationPlan
    ) {
        super(app);
    }

    openAndGetResult(): Promise<boolean> {
        this.open();
        return new Promise<boolean>((resolve) => {
            this.resolve = resolve;
        });
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText("Rotate ScreenMemory repo");
        contentEl
            .createEl("p")
            .setText(
                `This finishes pushing "${this.plan.oldLabel}", deletes the local screenshots for that month once the push is verified against GitHub, resets local git history, and switches to "${this.plan.newLabel}".`
            );

        const div = contentEl.createDiv({ cls: "modal-button-container" });

        const run = div.createEl("button", {
            cls: "mod-warning",
            text: "Run rotation",
        });
        run.addEventListener("click", () => {
            if (this.resolve) this.resolve(true);
            this.close();
        });

        const cancel = div.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => {
            if (this.resolve) this.resolve(false);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
        // Resolve `false` as a fallback if the modal was dismissed (e.g. Escape)
        // rather than via a button - a no-op if a button already resolved it.
        if (this.resolve) this.resolve(false);
    }
}
