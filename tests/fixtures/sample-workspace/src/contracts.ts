export interface ProjectSummary {
  id: string;
  label: string;
}

export class ProjectGraph {
  constructor(readonly project: ProjectSummary) {}

  describe(): string {
    return `${this.project.label} (${this.project.id})`;
  }
}
