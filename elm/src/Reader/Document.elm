module Reader.Document exposing
    ( Block(..)
    , Correction
    , Doc
    , Entry
    , Flow(..)
    , Inline(..)
    , NoteDef
    , Page
    , Para
    , RuleIndex
    , TocEntry
    , applyCorrections
    , applyIndexed
    , decoder
    , flow
    , noIndex
    , noteTexts
    , pageCount
    , ruleIndex
    )

{-| The DOCUMENT the reader consumes — the typed blocks a stored edition is
served as, and the grouping the view renders them in.

The served blocks are the VERBATIM transcription. Nothing here repairs them:
`corrections` travel beside the text as rules, and the reading view applies them
while the transcription view shows the blocks as they are. That is the whole
point of the two views, and of the diff view (which is the rule list itself).

The grouping in `flow` is a rendering concern, not a second transcription:

  - a note reference that splits a paragraph into two text runs is ONE paragraph
    with a superscript in the middle, because that is one paragraph in the print;
  - the pieces of one note (the edition sets a long note across several blocks)
    are ONE note;
  - a running head is furniture, suppressed in the reading view and shown in the
    transcription view.

Paragraph anchors (`#s4-3`) are derived from the block sequence: the extractor
labels only the paragraphs a reference lands on, so a paragraph without a label
takes the next number in its section that no labelled paragraph claims. That
keeps every anchor unique and in document order, which is what a reserved
grammar needs; it does not claim to be the extractor's own numbering.

-}

import Array exposing (Array)
import Dict exposing (Dict)
import Json.Decode as D
import Set exposing (Set)


type alias Doc =
    { slug : String
    , lang : String
    , item : String
    , pages : List Page
    , toc : List TocEntry
    , blocks : List Block
    , corrections : List Correction
    , damage : String
    , leftWords : List String
    }


type alias Page =
    { leaf : Maybe Int, page : Maybe Int }


{-| One division in the generated contents list.

  - `title` is the division's own opening words with the recorded repairs applied
    — the title the READING view shows, and the one the shell serves.
  - `raw` is the same words with no rule applied: the transcription's own title,
    which is what the TRANSCRIPTION view shows. The two are the two views of one
    line, so the contents list itself demonstrates the difference the whole reader
    is built on.
  - `damaged` marks a title the transcription damaged by more than the repairs
    can restore. It is never repaired by inventing a reading: the list states the
    gap (`damagedTitle`) and `raw` carries the words.
-}
type alias TocEntry =
    { id : String, n : Int, title : String, raw : String, damaged : Bool, page : Maybe Int }


{-| One recorded repair. `hits` is MEASURED when the document is built — how many
times the rule fires in the served text, in the order the rules are applied — and
it is carried here so the repairs list shows what each rule actually does instead
of recomputing it in the view (a view that re-derives the count is a second
answer to a question the document already answers). Every rule fires at least
once: the build fails on one that does not.
-}
type alias Correction =
    { find : String, repl : String, cls : String, note : String, hits : Int }


type Block
    = BRegion String (Maybe String)
    | BSec Int String (Maybe Int)
    | BPara String (Maybe String)
    | BVerse String (Maybe String)
    | BRh String
    | BPb (Maybe Int) String (Maybe String) (Maybe String)
    | BRef Int String (Maybe String) (Maybe String)
    | BNote Int String (Maybe String) (Maybe String)


{-| One rendered item. `region` says which part of the volume it belongs to, so
search hits and the progress meter can exclude the front matter and the
the end matter (the marks exist for exactly that). -}
type alias Entry =
    { region : String, item : Flow }


type Flow
    = FRegion String (Maybe String)
    | FSec Int String (Maybe Int)
    | FPage (Maybe Int) String (Maybe String) (Maybe String)
    | FRh String
    | FNote NoteDef
    | FPara Para


type alias NoteDef =
    { n : Int, id : Maybe String, lang : Maybe String, texts : List String }


type alias Para =
    { id : Maybe String, parts : List Inline }


type Inline
    = IText String
    | IVerse String
    | IRef Int String String
    | IPage (Maybe Int) String (Maybe String) (Maybe String)
    | IRh String


{-| The reading view: the rules applied in order, every occurrence. This is the
SEMANTICS the reading view promises; `applyIndexed` produces the same text
without looking at rules that cannot match. -}
applyCorrections : List Correction -> String -> String
applyCorrections rules text =
    List.foldl (\r acc -> String.replace r.find r.repl acc) text rules


{- ---------- applying the rules without looking at all of them ---------- -}

{-| The rule list, filed for lookup. Built once, when the document arrives.

The Theology edition carries 8,458 rules over 22,335 blocks, and the reading view
corrects every inline run it renders (and every passage the progress meter
measures). Applying every rule to every string is O(rules × text): MEASURED at
258,612,122 `String.replace` calls and ~74 s to render — a page that does not
load. The rules are data and stay data; what changes is how few of them are
LOOKED at. MEASURED after the change: 23,777, and ~3 s.

Two filters do the work, and both are needed:

  - WHICH RULES CAN MATCH AT ALL. Each rule is filed under a `keyLength`-character
    window of its own `find`, and the text's windows are looked up in that index.
    The rules found are a SUPERSET of the rules that can fire (a rule whose find
    occurs in the text has every one of its windows in the text) — and the window
    chosen is the rule's RAREST, which is what keeps the superset small. MEASURED
    on the Theology edition: 178 candidate rules per block filing each rule under
    its first window, 55 under its rarest, against 0.5 rules that actually fire.
    Rareness is counted over the rule list's own windows, which is enough: no
    window frequency over the text is available when the index is built, and over
    the rules it already separates the two by 3.3×.

  - WHICH OF THOSE MATCH HERE. Each candidate is then tested with `String.contains`
    — MEASURED three times cheaper than `String.replace`, which it replaces on
    the deciding path — and only the rules that pass are ordered and applied.

A rule whose `find` is shorter than the key is held in `short` and considered
every time: 49 rules in the Theology edition, which the `contains` test settles.
-}
type RuleIndex
    = Filed IndexData
    | Folded (List Correction)


type alias IndexData =
    { byKey : Dict String (List Filed)
    , short : List Filed
    , rules : Array Correction
    }


{-| One rule as the index files it: where it is in the rule list (the order it is
applied in), and the text it is looking for. Carrying the `find` in the index
saves a lookup into the rule array for every candidate the walk turns up — and on
the Theology edition the walk turns up 4 million of them. -}
type alias Filed =
    ( Int, String )


{-| How much of a rule is enough to find it by. Four characters: long enough that
the buckets are sparse, short enough that few rules fall outside the index. -}
keyLength : Int
keyLength =
    4


{-| No document, and so no rule applies. -}
noIndex : RuleIndex
noIndex =
    Folded []


{-| The number of rules below which the plain fold is the cheaper answer, MEASURED.

The walk costs about 1.3 µs per character of text it is handed (a dictionary
lookup per position, plus the `contains` test for each rule the lookup turns up),
and the fold costs about 0.75 ns per character PER RULE (a `String.replace` that
misses is a scan of the text). They cross at roughly 1,700 rules: MEASURED on the
built editions, porphyry (384 rules, 400-character passages) renders in 215 ms
folded and 405 ms walked, the Elements (415 rules) 490 ms and 572 ms — and the
Theology (8,458 rules, 100-character runs) 65,213 ms folded and 8,153 ms walked.

So the reading view takes the walk only where it pays. Both answers are the same
text — `applyCorrections` IS the semantics, and the walk reproduces it — so this
is a choice of work, not of result.
-}
foldBreakEven : Int
foldBreakEven =
    2048


{-| File the rules. The order the rules are applied in is their order in the
list, which the index preserves (indices, sorted when they are looked up). -}
ruleIndex : List Correction -> RuleIndex
ruleIndex rules =
    if List.length rules < foldBreakEven then
        Folded rules

    else
        let
            seen =
                List.foldl
                    (\r freq -> List.foldl (\g acc -> Dict.update g (\n -> Just (1 + Maybe.withDefault 0 n)) acc) freq (windows r.find))
                    Dict.empty
                    rules

            file ( i, r ) ( keys, shorts ) =
                case rarest seen r.find of
                    Just key ->
                        ( Dict.update key (\under -> Just (( i, r.find ) :: Maybe.withDefault [] under)) keys, shorts )

                    Nothing ->
                        ( keys, ( i, r.find ) :: shorts )

            filed =
                List.foldl file ( Dict.empty, [] ) (List.indexedMap Tuple.pair rules)
        in
        Filed
            { byKey = Tuple.first filed
            , short = Tuple.second filed
            , rules = Array.fromList rules
            }


{-| Every `keyLength`-character window of a string, in order. -}
windows : String -> List String
windows s =
    List.range 0 (String.length s - keyLength)
        |> List.map (\i -> String.slice i (i + keyLength) s)


{-| The window of this `find` that occurs least often across the whole rule list
— the one that will name the fewest other rules when a text is looked up under
it. Nothing for a find too short to have a window. -}
rarest : Dict String Int -> String -> Maybe String
rarest seen find =
    case windows find of
        [] ->
            Nothing

        first :: rest ->
            Just
                (Tuple.first
                    (List.foldl
                        (\g ( best, lowest ) ->
                            let
                                n =
                                    Maybe.withDefault 0 (Dict.get g seen)
                            in
                            if n < lowest then
                                ( g, n )

                            else
                                ( best, lowest )
                        )
                        ( first, Maybe.withDefault 0 (Dict.get first seen) )
                        rest
                    )
                )


{-| Apply the rules to one text in rule order, every occurrence — the same text
`applyCorrections` gives, from the rules that can match it.

The subtlety, and the reason this is not simply "apply the rules whose find is in
the text": a rule can fire inside text an EARLIER rule produced, so its own find
need not occur in the text as it arrived. MEASURED: 59 of the Theology edition's
11,728 firings are of that kind (the rule `motion:` fires inside what the rule
before it repaired). So whenever a rule changes the text, the rules still to come
are re-derived from the text it produced — and only those: a rule that has had
its turn does not get a second one, which is exactly the fold's rule.
-}
applyIndexed : RuleIndex -> String -> String
applyIndexed ix text =
    case ix of
        Folded rules ->
            applyCorrections rules text

        Filed idx ->
            applyStep idx text (candidates idx text)


applyStep : IndexData -> String -> List Int -> String
applyStep idx text todo =
    case todo of
        [] ->
            text

        i :: rest ->
            case Array.get i idx.rules of
                Nothing ->
                    applyStep idx text rest

                Just r ->
                    if String.contains r.find text then
                        let
                            after =
                                String.replace r.find r.repl text
                        in
                        applyStep idx after (merge rest (List.filter (\j -> j > i) (candidates idx after)))

                    else
                        applyStep idx text rest


{-| The rules that can fire on this text, in rule order: every rule filed under a
window of the text (and every short rule), keep only those whose `find` the text
contains, one copy of each.

A rule whose find occurs in the text always passes both steps — the window test
because the find's windows are in the text, the `contains` test because that is
what it is — so nothing that can fire is dropped.

The window walk is written as one tail-recursive function over the positions, and
the `contains` test is made inside it rather than in a second `List.filter`: on
the Theology edition this walk runs 4.3 million times, and MEASURED, the lists it
would otherwise build (`List.range`, `List.map`, `List.concatMap`) and the
closures each of them calls through cost more than the lookups themselves.
-}
candidates : IndexData -> String -> List Int
candidates idx text =
    walk idx text 0 (String.length text - keyLength) (keep idx text idx.short [])
        |> List.map Tuple.first
        |> List.sort
        |> dedupe


{-| Every rule filed under a window of this text, kept when the text contains its
`find`, and the short rules with them. -}
walk : IndexData -> String -> Int -> Int -> List Filed -> List Filed
walk idx text i last acc =
    if i > last then
        acc

    else
        case Dict.get (String.slice i (i + keyLength) text) idx.byKey of
            Nothing ->
                walk idx text (i + 1) last acc

            Just found ->
                walk idx text (i + 1) last (keep idx text found acc)


{-| The rules of this list whose `find` the text contains, in front of the
accumulator. An over-wide list costs a `contains` test here, never a wrong
answer: a rule that does not pass cannot fire. -}
keep : IndexData -> String -> List Filed -> List Filed -> List Filed
keep idx text rules acc =
    case rules of
        [] ->
            acc

        (( _, find ) as filed) :: rest ->
            if String.contains find text then
                keep idx text rest (filed :: acc)

            else
                keep idx text rest acc


{-| One copy of each, from a sorted list. -}
dedupe : List a -> List a
dedupe xs =
    case xs of
        a :: ((b :: _) as rest) ->
            if a == b then
                dedupe rest

            else
                a :: dedupe rest

        _ ->
            xs


{-| Two sorted, duplicate-free lists as one. -}
merge : List Int -> List Int -> List Int
merge a b =
    case ( a, b ) of
        ( [], _ ) ->
            b

        ( _, [] ) ->
            a

        ( x :: xs, y :: ys ) ->
            if x < y then
                x :: merge xs b

            else if y < x then
                y :: merge a ys

            else
                x :: merge xs ys


{-| Note text by number, for the margin copy and the popover — a note is never
looked up by page, so a note and its reference on different pages costs nothing.
-}
noteTexts : List Entry -> Dict Int String
noteTexts entries =
    List.foldl
        (\e acc ->
            case e.item of
                FNote n ->
                    Dict.insert n.n (String.join " " n.texts) acc

                _ ->
                    acc
        )
        Dict.empty
        entries


pageCount : Doc -> Int
pageCount doc =
    List.length (List.filter (\p -> p.page /= Nothing) doc.pages)


{- ---------- the decoder ---------- -}

decoder : D.Decoder Doc
decoder =
    D.oneOf [ D.field "corrections" (D.list correction), D.succeed [] ]
        |> D.andThen
            (\cs ->
                D.map8 (\s l i ps t bs dmg left -> Doc s l i ps t bs cs dmg left)
                    (D.field "slug" D.string)
                    (D.field "lang" D.string)
                    (D.field "source" (D.field "item" D.string))
                    (D.field "pages" (D.list page))
                    (D.field "toc" (D.list tocEntry))
                    (D.field "blocks" (D.list block))
                    -- the base policy's damage set, and the words the policy
                    -- leaves visible: a document built before the policy carries
                    -- neither, and then nothing is marked as damaged apparatus
                    (D.oneOf [ D.field "damage" D.string, D.succeed "" ])
                    (D.oneOf
                        [ D.field "correctionsMeta" (D.field "leftWords" (D.list D.string))
                        , D.succeed []
                        ]
                    )
            )


page : D.Decoder Page
page =
    D.map2 Page (D.maybe (D.field "leaf" D.int)) (D.maybe (D.field "page" D.int))


tocEntry : D.Decoder TocEntry
tocEntry =
    D.map6 TocEntry
        (D.field "id" D.string)
        (D.field "n" D.int)
        (D.field "title" D.string)
        -- a document built before the title fix carries neither field: the raw
        -- title is then the title, and nothing is claimed to be damaged
        (D.oneOf [ D.field "raw" D.string, D.field "title" D.string ])
        (D.oneOf [ D.field "damaged" D.bool, D.succeed False ])
        (D.maybe (D.field "page" D.int))


correction : D.Decoder Correction
correction =
    D.map5 Correction
        (D.field "find" D.string)
        (D.field "repl" D.string)
        (D.field "cls" D.string)
        (D.field "note" D.string)
        (D.oneOf [ D.field "hits" D.int, D.succeed 0 ])


block : D.Decoder Block
block =
    D.field "t" D.string
        |> D.andThen
            (\t ->
                case t of
                    "region" ->
                        D.map2 BRegion
                            (D.field "kind" D.string)
                            (D.maybe (D.field "id" D.string))

                    "sec" ->
                        D.map3 BSec
                            (D.field "n" D.int)
                            (D.field "id" D.string)
                            (D.maybe (D.field "page" D.int))

                    "p" ->
                        D.map2 BPara
                            (D.field "x" D.string)
                            (D.maybe (D.field "at" D.string))

                    "verse" ->
                        D.map2 BVerse
                            (D.field "x" D.string)
                            (D.maybe (D.field "at" D.string))

                    "rh" ->
                        D.map BRh (D.field "x" D.string)

                    "pb" ->
                        D.map4 BPb
                            (D.maybe (D.field "page" D.int))
                            (D.field "how" D.string)
                            (D.maybe (D.field "id" D.string))
                            (D.maybe (D.field "x" D.string))

                    "ref" ->
                        D.map4 BRef
                            (D.field "n" D.int)
                            (D.field "x" D.string)
                            (D.maybe (D.field "at" D.string))
                            (D.maybe (D.field "id" D.string))

                    "notedef" ->
                        D.map4 BNote
                            (D.field "n" D.int)
                            (D.field "x" D.string)
                            (D.maybe (D.field "id" D.string))
                            (D.maybe (D.field "lang" D.string))

                    _ ->
                        D.fail ("unknown block type " ++ t)
            )


{- ---------- grouping ---------- -}

type Open
    = ONone
    | OPara (Maybe String) Bool (List Inline)
    | ONote NoteDef


type alias St =
    { region : String
    , section : Maybe String
    , labels : Set String
    , used : Set String
    , out : List Entry
    , open : Open
    , lastRef : Bool
    }


{-| Every block, in document order, grouped for rendering. -}
flow : List Block -> List Entry
flow blocks =
    let
        labels =
            -- the paragraph labels the extractor itself assigns, per section: a
            -- derived number must not take one of them
            List.foldl
                (\b acc ->
                    case ( b, List.head acc.stack ) of
                        ( BSec _ id _, _ ) ->
                            { acc | stack = id :: acc.stack }

                        ( BPara _ (Just at), Just sec ) ->
                            { acc | bySection = Dict.update sec (addLabel at) acc.bySection }

                        ( BVerse _ (Just at), Just sec ) ->
                            { acc | bySection = Dict.update sec (addLabel at) acc.bySection }

                        _ ->
                            acc
                )
                { stack = [], bySection = Dict.empty }
                blocks

        st =
            List.foldl (step labels.bySection)
                { region = ""
                , section = Nothing
                , labels = Set.empty
                , used = Set.empty
                , out = []
                , open = ONone
                , lastRef = False
                }
                blocks
    in
    (close st).out |> List.reverse


addLabel : String -> Maybe (Set String) -> Maybe (Set String)
addLabel at acc =
    acc |> Maybe.withDefault Set.empty |> Set.insert at |> Just


emit : St -> Flow -> St
emit st item =
    { st | out = { region = st.region, item = item } :: st.out, open = ONone }


close : St -> St
close st =
    case st.open of
        OPara id _ parts ->
            if List.isEmpty parts then
                { st | open = ONone }

            else
                { st | out = { region = st.region, item = FPara { id = id, parts = List.reverse parts } } :: st.out, open = ONone }

        ONote n ->
            { st | out = { region = st.region, item = FNote n } :: st.out, open = ONone }

        ONone ->
            st


step : Dict String (Set String) -> Block -> St -> St
step bySection b st =
    case b of
        BRegion kind id ->
            -- the region is set on the state and CARRIED by every entry after it:
            -- the front matter and the end matter are excluded from search
            -- and from the progress meter by this mark, and an entry that reports
            -- no region excludes nothing. (MEASURED: with the region unset every
            -- item read as "" and both exclusions were inert.)
            let
                closed =
                    close st
            in
            emit { closed | region = kind } (FRegion kind id)

        BSec n id pg ->
            emit (close { st | section = Just id, used = Set.empty, labels = Dict.get id bySection |> Maybe.withDefault Set.empty }) (FSec n id pg)

        BPb pg how id raw ->
            case st.open of
                OPara pid authOn parts ->
                    -- A PAGE BOUNDARY INSIDE A PARAGRAPH IS INLINE. The paragraph
                    -- runs across the page break (MEASURED: the print's paragraphs
                    -- do), so the marker belongs inside it — closing the paragraph
                    -- here cut one sentence into two and is what the author saw.
                    { st | open = OPara pid authOn (IPage pg how id raw :: parts) }

                _ ->
                    emit (close st) (FPage pg how id raw)

        BRh x ->
            case st.open of
                OPara pid authOn parts ->
                    { st | open = OPara pid authOn (IRh x :: parts) }

                _ ->
                    emit (close st) (FRh x)

        BPara x at ->
            appendOrOpen st (IText x) at

        BVerse x at ->
            appendOrOpen st (IVerse x) at

        BRef n x at id ->
            case st.open of
                OPara oid authOn parts ->
                    let
                        ( nid, nauth ) =
                            case ( oid, at ) of
                                ( Nothing, Just a ) ->
                                    ( Just a, True )

                                _ ->
                                    ( oid, authOn )
                    in
                    { st
                        | open = OPara nid nauth (IRef n x (Maybe.withDefault "" id) :: parts)
                        , lastRef = True
                        , used = addUsed nid st.used
                    }

                _ ->
                    let
                        nid =
                            at

                        nauth =
                            at /= Nothing
                    in
                    { st
                        | open = OPara nid nauth [ IRef n x (Maybe.withDefault "" id) ]
                        , lastRef = True
                        , used = addUsed nid st.used
                    }

        BNote n x id lang ->
            case st.open of
                ONote prev ->
                    if prev.n == n then
                        { st
                            | open =
                                ONote
                                    { prev
                                        | texts = x :: prev.texts
                                        , id = firstJust prev.id id
                                        , lang = firstJust prev.lang lang
                                    }
                            , lastRef = False
                        }

                    else
                        openNote (close st) n x id lang

                _ ->
                    openNote (close st) n x id lang


{-| A text block continues the open paragraph when it is the SAME paragraph — the
extractor's own label decides, so two different labelled paragraphs are never
merged into one anchor, and the blocks the transcription split at a blank line
that is not a paragraph mark (the blank lines are page breaks and the scanner's
own line blocks, not the print's paragraphs) are joined back into the one
paragraph the print has. A reference that split a paragraph keeps merging too:
its parts carry the same label. -}
appendOrOpen : St -> Inline -> Maybe String -> St
appendOrOpen st part at =
    case st.open of
        OPara id authOn parts ->
            if at /= Nothing && at == id then
                { st | open = OPara id authOn (continuationParts st.lastRef parts part), lastRef = False }

            else if st.lastRef && at == id then
                { st | open = OPara id authOn (part :: parts), lastRef = False }

            else if st.lastRef && at == Nothing && not authOn then
                { st | open = OPara id authOn (part :: parts), lastRef = False }

            else
                openPara (close st) part at

        _ ->
            openPara (close st) part at


{-| The parts of ONE paragraph, accumulated back-to-front, as the next block joins
it. A REFERENCE split the paragraph mid-text, so its halves meet with no
separator. Two BLOCKS that share the paragraph label were split at a blank line —
a word boundary, so they meet with a SPACE, unless the first ends in a hyphen and
the word runs on (`perse-` | `verance` is one word). -}
continuationParts : Bool -> List Inline -> Inline -> List Inline
continuationParts wasReference parts part =
    if wasReference then
        part :: parts

    else
        case parts of
            IText t :: _ ->
                if String.endsWith "-" t then
                    part :: parts

                else
                    IText " " :: part :: parts

            _ ->
                IText " " :: part :: parts


firstJust : Maybe a -> Maybe a -> Maybe a
firstJust a b =
    case a of
        Just _ ->
            a

        Nothing ->
            b


addUsed : Maybe String -> Set String -> Set String
addUsed id used =
    case id of
        Just i ->
            Set.insert i used

        Nothing ->
            used


openPara : St -> Inline -> Maybe String -> St
openPara st part at =
    let
        id =
            case at of
                Just a ->
                    Just a

                Nothing ->
                    case st.section of
                        Just sec ->
                            Just (sec ++ "-" ++ String.fromInt (nextFree st 1))

                        Nothing ->
                            Nothing
    in
    { st
        | open = OPara id (at /= Nothing) [ part ]
        , lastRef = False
        , used = addUsed id st.used
    }


{-| The lowest number in this section that neither a labelled paragraph nor an
already-numbered one claims — unique, and in document order. -}
nextFree : St -> Int -> Int
nextFree st from =
    let
        candidate =
            case st.section of
                Just sec ->
                    sec ++ "-" ++ String.fromInt from

                Nothing ->
                    ""
    in
    if Set.member candidate st.labels || Set.member candidate st.used then
        nextFree st (from + 1)

    else
        from


openNote : St -> Int -> String -> Maybe String -> Maybe String -> St
openNote st n x id lang =
    { st | open = ONote { n = n, id = id, lang = lang, texts = [ x ] }, lastRef = False }
