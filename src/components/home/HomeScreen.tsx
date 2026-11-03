import { DASHBOARD_ORDER } from '@/forms/registry';
import { STAGE_ICON } from '@/components/ui/statusMaps';
import { BrandMedallion } from '@/components/ui/BrandMedallion';
import { HomeTile } from '@/components/home/HomeTile';

export interface HomeScreenProps {
  /** False for a role that records nothing — an auditor, or an unassigned account. */
  readonly mayRecord: boolean;
}

/**
 * Home: the testing forms, and nothing else.
 *
 * ===========================================================================
 * WHAT THIS SCREEN STOPPED CARRYING, AND WHERE IT WENT
 * ===========================================================================
 * It used to be the whole application on a phone. The shell was deleted on
 * this route to win back roughly 380px, so the screen grew its own brand
 * block, its own connection chip, its own plant date, and a 'More' sheet
 * holding the record destinations, the queue counts, the signed-in identity
 * and the only Sign out button in the app.
 *
 * The navigation moved to a bottom bar that costs about 58px, which makes
 * that trade unnecessary. The header carries brand, connection and identity
 * again on every screen; `PrimaryNav` carries the destinations; the queue
 * figures have a screen of their own in Flagged. So this is back to the one
 * job Master Prompt section 2 gives it: the numbered stage cards are the
 * only way into a testing form, and nothing here may read as an extra one.
 *
 * ===========================================================================
 * IT MAY SCROLL NOW, AND THAT IS THE POINT OF THE TRADE
 * ===========================================================================
 * The old grid divided the viewport into exact rows so that every tile was
 * reachable without scrolling, which is why it had a hard cell cap and an
 * e2e check on tile height. That contract bought its height by deleting the
 * chrome, and the chrome is back. Seven tiles in two columns is four rows;
 * on the shortest supported phone the last row may sit below the fold.
 *
 * A thumb-flick is a smaller cost than a navigation bar the operator cannot
 * see, and the tiles keep their `min-h-tap` floor either way. HORIZONTAL
 * scroll is still forbidden and still checked — that one is a layout fault,
 * not a trade.
 */
export function HomeScreen({ mayRecord }: HomeScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      {/*
        THE MASTHEAD, kept at the owner's instruction.

        It was briefly dropped when the navigation moved to a bottom bar and
        this screen lost its bespoke full-height layout — the header already
        carries a small mark, so a second one looked redundant from the
        inside. It is not redundant from the outside: this is the screen a
        sampler opens at the start of a shift, on a shared tablet, and the
        company's mark at the top of it is the point rather than decoration.

        It no longer claims a literal third of the viewport. `basis-1/3` only
        meant anything while this screen WAS the viewport, dividing a fixed
        height between the masthead and the grid; inside the normal page flow
        it would resolve against nothing. The medallion is sized directly
        instead, which is what produced the visual that was asked for.
      */}
      <div className="flex flex-col items-center justify-center gap-3 pt-2">
        <BrandMedallion size={128} />
        <div className="text-center">
          <h1
            id="home-heading"
            className="text-lg font-bold uppercase tracking-wide text-bff-800"
          >
            Sample testing
          </h1>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-600">
            Bounty Farm Limited
          </p>
        </div>
      </div>

      <p className="text-base text-slate-600">
        {mayRecord
          ? 'Select a stage to record results.'
          : 'Your role does not record samples. Use the bar below to open the records you can read.'}
      </p>

      {mayRecord ? (
        <nav aria-labelledby="home-heading">
          <ul className="grid grid-cols-2 gap-4">
            {DASHBOARD_ORDER.map((schema) => (
              <li key={schema.stage}>
                <HomeTile
                  ordinal={schema.ordinal}
                  label={schema.title}
                  icon={STAGE_ICON[schema.stage]}
                  to={`/stage/${schema.stage}`}
                />
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
