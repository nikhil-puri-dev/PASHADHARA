import { CREATOR } from "./chrome";

export function About() {
  return (
    <section className="stage" id="about" aria-labelledby="about-h">
      <div className="stage-h"><span className="stage-n">5</span><h2 id="about-h">Trust needs <em>a mechanism.</em></h2></div>
      <div className="about-copy">
          <p className="about-lead">I’m {CREATOR.name}. I built Pashadhara around a question. How much freedom can you give an agent while keeping a limit you can rely on?</p>
          <p>I want agents to be free to explore, decide and act. The boundary has to hold whatever the agent wants. Here that means a PayPal hold, a gateway that refuses before it charges, and books that have to match what PayPal says.</p>
          <p className="about-links"><a href={CREATOR.github}>Nikhil on GitHub</a></p>
      </div>
    </section>
  );
}
