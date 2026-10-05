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
    , TocEntry
    , applyCorrections
    , decoder
    , flow
    , noteTexts
    , pageCount
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


{-| The reading view: the rules applied in order, every occurrence. -}
applyCorrections : List Correction -> String -> String
applyCorrections rules text =
    List.foldl (\r acc -> String.replace r.find r.repl acc) text rules


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
