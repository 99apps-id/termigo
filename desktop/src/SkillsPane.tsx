import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import type { SkillInfo } from './types';

export default function SkillsPane({ workspacePath, onStatus }: { workspacePath: string; onStatus: (message: string) => void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      setSkills(await invoke<SkillInfo[]>('skills_list'));
    } catch (error) {
      onStatus(`Skills: ${message(error)}`);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <section className="skills-pane" aria-label="Skills">
    <div className="skills-heading">
      <div><strong>SKILLS</strong><span>project and user scopes</span></div>
      <button className="button ghost" onClick={() => void refresh()} disabled={loading}>Refresh</button>
    </div>

    <div className="skills-body">
      {skills.length === 0 && <div className="skills-empty">
        <div className="agent-empty-mark">✦</div>
        <h2>No skills yet.</h2>
        <p>Skills live in <code>.termigo/skills/&lt;name&gt;/SKILL.md</code> and teach agents how to work in this project.</p>
        <p>Create one with <code>termigo skill create &lt;name&gt;</code> — the CLI companion scaffolds the folder for you.</p>
      </div>}
      {skills.map(skill => <article className="skill-card" key={`${skill.scope}-${skill.name}`}>
        <div className="skill-card-top"><strong>{skill.name}</strong><span className={`skill-scope ${skill.scope}`}>{skill.scope}</span></div>
        <p>{skill.description}</p>
        <code className="skill-path">{skill.path}</code>
      </article>)}
    </div>
  </section>;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
