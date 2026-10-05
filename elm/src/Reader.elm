port module Reader exposing (main)

{-| The reader: one fetched document, two views of it, and the furniture a
printed book has — a contents list, page numbers, notes, and a page you can
point at.

Everything shown comes from the served document plus two values the page hands
over at mount: where the reader was, and the edition's own bibliographic line.
The document carries the item and its digest, not the imprint, so the citation is
assembled from what the page was built with — never hard-coded here.

Ports are the whole of the outside world: the page fetches the document, scrolls,
writes the fragment, and keeps the stored position; this module decides what those
mean.

-}

import Browser
import Dict exposing (Dict)
import Html exposing (Html, a, aside, br, button, code, div, em, footer, h1, h2, h3, header, input, label, li, main_, mark, nav, ol, p, section, span, strong, sup, table, tbody, td, text, th, thead, tr, ul)
import Html.Attributes as A exposing (attribute, class, disabled, href, id, placeholder, title, type_, value)
import Html.Events as Ev
import Json.Decode as D
import Json.Encode as E
import Reader.Document as Doc exposing (Block(..), Correction, Doc, Entry, Flow(..), Inline(..))
import Reader.Store as Store exposing (Bookmark, Stored)
import Set exposing (Set)


{- ---------- ports: the page is the outside world ---------- -}

port requestDoc : String -> Cmd msg


port docReceived : (String -> msg) -> Sub msg


port docFailed : (String -> msg) -> Sub msg


port jumpTo : String -> Cmd msg


port focusOn : String -> Cmd msg


port setHash : String -> Cmd msg


port persist : E.Value -> Cmd msg


port hashChanged : (String -> msg) -> Sub msg


port scrolled : (Int -> msg) -> Sub msg



{- ---------- model ---------- -}


type View
    = Reading
    | Transcription


type alias Citation =
    { author : String
    , title : String
    , translator : String
    , place : String
    , publisher : String
    , year : String
    }


type alias Flags =
    { slug : String
    , url : String
    , base : String
    , hash : String
    , citation : Citation
    , repair : Maybe RepairState
    , stored : D.Value
    }


{-| The edition's repair state, when it has one: readable, and not finished. -}
type alias RepairState =
    { state : String
    , label : String
    , note : String
    }


type alias Model =
    { slug : String
    , url : String
    , base : String
    , citation : Citation
    , hash0 : String
    , repair : Maybe RepairState
    , doc : Maybe Doc
    , entries : List Entry
    , notes : Dict Int String
    , noteLangs : Dict Int String
    , anchors : Dict String Int
    , failed : Bool
    , notice : String
    , view : View
    , drawer : Bool
    , q : String
    , hits : List Int
    , hitIx : Int
    , jump : String
    , posIx : Int
    -- THE PAGE THE READER NAVIGATED TO, when it is a printed page. A paragraph
    -- that runs across a page turn is ONE entry, so the entry alone cannot say
    -- whether the reader is on the page the paragraph started on or the one it
    -- turned onto (MEASURED: jumping to page 15, inside a paragraph that starts on
    -- p.14, reported p.14). Set when a page is gone to, cleared by a scroll.
    , atPage : Maybe Int
    , open : Maybe Int
    , cite : Bool
    -- The passage the open citation panel is ABOUT (plan §11 phase 5). The panel
    -- is an overlay, so a reader who scrolls to another passage with it open does
    -- not thereby change the citation they asked for; frozen when the panel opens.
    , citeIx : Int
    , showRules : Bool
    , range : Maybe ( Int, Int )
    , scale : Int
    , typing : Bool
    , stored : Stored
    }


init : Flags -> ( Model, Cmd Msg )
init flags =
    let
        stored =
            Store.decode flags.stored

        empty =
            { slug = flags.slug
            , url = flags.url
            , base = flags.base
            , citation = flags.citation
            , hash0 = flags.hash
            , repair = flags.repair
            , doc = Nothing
            , entries = []
            , notes = Dict.empty
            , noteLangs = Dict.empty
            , anchors = Dict.empty
            , failed = False
            , notice = ""
            , view =
                if stored.view == "transcription" then
                    Transcription

                else
                    Reading
            , drawer = False
            , q = ""
            , hits = []
            , hitIx = 0
            , jump = ""
            , posIx = 0
            , atPage = Nothing
            , open = Nothing
            , cite = False
            , citeIx = 0
            , showRules = False
            , range = Nothing
            , scale = stored.scale
            , typing = False
            , stored = stored
            }
    in
    ( empty, requestDoc flags.url )



{- ---------- messages ---------- -}


type Msg
    = GotDoc String
    | DocLoadFailed String
    | ViewSet View
    | DrawerToggle
    | DrawerClose
    | Query String
    | HitStep Int
    | JumpInput String
    | JumpGo
    | GoPage Int
    | GoAnchor String
    | HashIn String
    | NoteOpen Int
    | NoteClose Int
    | NoteBack Int
    | CiteToggle
    | RulesToggle
    | RangeFrom String
    | RangeTo String
    | RangeClear
    | RangeCurrent
    | BookmarkAdd
    | BookmarkRemove String
    | ScaleSet Int
    | ScrolledTo Int
    | Key String Bool
    | Typing Bool
    | Noop



{- ---------- update ---------- -}


update : Msg -> Model -> ( Model, Cmd Msg )
update msg m =
    case msg of
        GotDoc raw ->
            case D.decodeString Doc.decoder raw of
                Ok doc ->
                    let
                        entries =
                            Doc.flow doc.blocks

                        m1 =
                            { m
                                | doc = Just doc
                                , entries = entries
                                , notes = Doc.noteTexts entries
                                , noteLangs = noteLanguages entries
                                , anchors = buildAnchors entries
                            }

                        fromHash =
                            hashOf m1.hash0
                    in
                    if String.isEmpty fromHash then
                        case m1.stored.position of
                            Just aid ->
                                if String.isEmpty aid then
                                    ( m1, Cmd.none )

                                else
                                    restoreSilent aid m1

                            Nothing ->
                                ( m1, Cmd.none )

                    else
                        goToSilent fromHash m1

                Err _ ->
                    ( { m | failed = True }, Cmd.none )

        DocLoadFailed _ ->
            ( { m | failed = True }, Cmd.none )

        ViewSet v ->
            ( { m | view = v }, Cmd.none )

        DrawerToggle ->
            let
                open =
                    not m.drawer
            in
            ( { m | drawer = open }
            , focusOn
                (if open then
                    "rd-nav"

                 else
                    "rd-drawer-btn"
                )
            )

        DrawerClose ->
            ( { m | drawer = False }, focusOn "rd-drawer-btn" )

        Query q ->
            ( search q m, Cmd.none )

        HitStep d ->
            stepHit d m

        JumpInput s ->
            ( { m | jump = s }, Cmd.none )

        JumpGo ->
            case String.toInt (String.trim m.jump) of
                Just n ->
                    gotoPage n m

                Nothing ->
                    ( m, Cmd.none )

        GoPage n ->
            gotoPage n m

        GoAnchor aid ->
            goTo aid m

        HashIn h ->
            let
                aid =
                    hashOf h
            in
            if String.isEmpty aid then
                ( m, Cmd.none )

            else
                goToSilent aid m

        NoteOpen n ->
            ( { m | open = Just n }
            , Cmd.batch [ setHash ("n" ++ String.fromInt n), persistCmd m, focusOn "rd-pop" ]
            )

        NoteClose n ->
            ( { m | open = Nothing }, focusOn ("r" ++ String.fromInt n) )

        NoteBack n ->
            let
                ( m1, cmd ) =
                    goTo ("r" ++ String.fromInt n) m
            in
            ( { m1 | open = Nothing }, cmd )

        CiteToggle ->
            let
                open =
                    not m.cite
            in
            -- opening freezes the passage the citation is about; closing leaves it
            -- where it was, so re-opening on the same passage is stable
            ( { m | cite = open, citeIx = (if open then m.posIx else m.citeIx) }
            , if open then
                focusOn "rd-cite"

              else
                Cmd.none
            )

        RulesToggle ->
            -- opening moves focus into the overlay and closing returns it to the
            -- control that opened it: the panel is a dialog, so a keyboard reader
            -- has to be able to reach it (and Escape from it) and to get back.
            -- Both are `position: fixed`, so neither focus moves the reading position.
            ( { m | showRules = not m.showRules }
            , if m.showRules then
                focusOn "rd-rules-btn"

              else
                focusOn "rd-rules"
            )

        RangeFrom s ->
            case String.toInt (String.trim s) of
                Just from ->
                    let
                        to =
                            m.range |> Maybe.map Tuple.second |> Maybe.withDefault from
                    in
                    ( { m | range = Just ( from, max from to ) }, Cmd.none )

                Nothing ->
                    ( { m | range = Just ( 0, m.range |> Maybe.map Tuple.second |> Maybe.withDefault 0 ) }, Cmd.none )

        RangeTo s ->
            case String.toInt (String.trim s) of
                Just to ->
                    let
                        from =
                            m.range |> Maybe.map Tuple.first |> Maybe.withDefault to
                    in
                    ( { m | range = Just ( min from to, to ) }, Cmd.none )

                Nothing ->
                    ( { m | range = Just ( m.range |> Maybe.map Tuple.first |> Maybe.withDefault 0, 0 ) }, Cmd.none )

        RangeClear ->
            ( { m | range = Nothing }, Cmd.none )

        RangeCurrent ->
            case currentPage m of
                Just pg ->
                    ( { m | range = Just ( pg, pg ) }, Cmd.none )

                Nothing ->
                    ( m, Cmd.none )

        BookmarkAdd ->
            let
                label =
                    positionLabel m

                bm =
                    { id = anchorAt m m.posIx, label = label, page = currentPage m }

                m1 =
                    { m | stored = { st0 | bookmarks = bm :: List.filter (\b -> b.id /= bm.id) st0.bookmarks } }
            in
            ( { m1 | notice = "Bookmarked: " ++ label }, persistCmd m1 )

        BookmarkRemove bid ->
            let
                m1 =
                    { m | stored = { st0 | bookmarks = List.filter (\b -> b.id /= bid) st0.bookmarks } }
            in
            ( m1, persistCmd m1 )

        ScaleSet n ->
            ( { m | scale = clamp 1 6 n }, Cmd.none )

        ScrolledTo ix ->
            if ix == m.posIx || ix < 0 || ix >= List.length m.entries then
                ( m, Cmd.none )

            else
                -- a scroll means the reader moved by reading, not by a page jump,
                -- so the pinned page no longer describes where they are
                ( { m | posIx = ix, atPage = Nothing }, persistCmd { m | posIx = ix } )

        Typing on ->
            ( { m | typing = on }, Cmd.none )

        Key key shift ->
            if m.typing then
                ( m, Cmd.none )

            else
                case key of
                    "ArrowLeft" ->
                        if shift then
                            stepSection -1 m

                        else
                            stepPage -1 m

                    "ArrowRight" ->
                        if shift then
                            stepSection 1 m

                        else
                            stepPage 1 m

                    "Escape" ->
                        -- one layer at a time: the repairs list covers the page,
                        -- so it goes first, and focus goes back to its control;
                        -- then the drawer and the note popover, as before.
                        if m.showRules then
                            ( { m | showRules = False }, focusOn "rd-rules-btn" )

                        else
                            ( { m | drawer = False, open = Nothing }, Cmd.none )

                    _ ->
                        ( m, Cmd.none )

        Noop ->
            ( m, Cmd.none )


st0 : Stored
st0 =
    Store.empty


{-| The popover follows the fragment: a link to a note opens the note, and any
other jump closes it. -}
withNote : String -> Model -> Model
withNote aid m =
    case noteOf aid of
        Just n ->
            if Dict.member n m.notes then
                { m | open = Just n }

            else
                { m | open = Nothing }

        Nothing ->
            { m | open = Nothing }


persistCmd : Model -> Cmd msg
persistCmd m =
    let
        s =
            Store.encode
                { position = Just (anchorAt m m.posIx)
                , page = currentPage m
                , section = currentSection m
                , bookmarks = m.stored.bookmarks
                , view = viewName m.view
                , scale = m.scale
                }
    in
    persist s


viewName : View -> String
viewName v =
    case v of
        Reading ->
            "reading"

        Transcription ->
            "transcription"


{-| A restored position: set it in the MODEL, and do not scroll. Landing on an
edition page is not a navigation — the page's bibliographic record and its
citation are the top, and a returning reader was being yanked past them down to
their old position (the reported defect). The meter, the contents list and "you
are here" read `posIx`, so the position must be restored; `jumpTo` is what must
not run. A `#fragment` still scrolls — see the `GotDoc` branch above, which routes
it to `goToSilent` and is a deep link, not a resume. A stored anchor the text no
longer holds is left alone, silently: a landing must not open on an error about a
position the reader did not ask for. -}
restoreSilent : String -> Model -> ( Model, Cmd Msg )
restoreSilent aid m =
    case Dict.get aid m.anchors of
        Just ix ->
            ( withNote aid { m | posIx = ix, atPage = pageAnchor m.entries aid }, Cmd.none )

        Nothing ->
            ( m, Cmd.none )


{-| A jump the browser already made — a fragment the reader arrived on, or a
hashchange: scroll, but do not write the fragment back — re-setting it would
fight the reader's back button. -}
goToSilent : String -> Model -> ( Model, Cmd Msg )
goToSilent aid m =
    case Dict.get aid m.anchors of
        Just ix ->
            -- a hash the reader arrived on is a navigation like any other: if it
            -- names a printed page, the position is that page (see `atPage`)
            ( withNote aid { m | posIx = ix, atPage = pageAnchor m.entries aid }, jumpTo aid )

        Nothing ->
            ( { m | notice = "Nothing here is called " ++ aid }, Cmd.none )


{-| The printed page an anchor names, when it names one. -}
pageAnchor : List Entry -> String -> Maybe Int
pageAnchor entries aid =
    pageIndex entries
        |> List.filter (\( _, a, _ ) -> a == aid)
        |> List.head
        |> Maybe.map (\( _, _, pg ) -> pg)


{-| A jump the reader asked for: scroll AND leave the fragment in the URL, so a
link copied out of the app resolves. -}
goTo : String -> Model -> ( Model, Cmd Msg )
goTo aid m =
    case Dict.get aid m.anchors of
        Just ix ->
            let
                pinned =
                    pageAnchor m.entries aid

                m1 =
                    withNote aid { m | posIx = ix, atPage = pinned }
            in
            ( m1, Cmd.batch [ jumpTo aid, setHash aid, persistCmd m1 ] )

        Nothing ->
            ( { m | notice = "Nothing here is called " ++ aid }, Cmd.none )


gotoPage : Int -> Model -> ( Model, Cmd Msg )
gotoPage n m =
    case List.filter (\( _, _, pg ) -> pg == n) (pageIndex m.entries) |> List.head of
        Just ( _, aid, _ ) ->
            goTo aid m

        Nothing ->
            ( { m | notice = "No printed page " ++ String.fromInt n ++ " in this text" }, Cmd.none )


stepPage : Int -> Model -> ( Model, Cmd Msg )
stepPage d m =
    let
        pages =
            pageIndex m.entries
    in
    case currentPage m of
        Just pg ->
            -- the front matter has no printed page, so a step from it enters the
            -- text (forward) or refuses (back): the boundary is a stated limit,
            -- never a wrapped page
            case pagePosition pages pg of
                Just i ->
                    case List.head (List.drop (i + d) pages) of
                        Just ( _, aid, _ ) ->
                            goTo aid m

                        Nothing ->
                            ( { m
                                | notice =
                                    if d > 0 then
                                        "The last printed page"

                                    else
                                        "The first printed page of the text"
                              }
                            , Cmd.none
                            )

                Nothing ->
                    ( m, Cmd.none )

        Nothing ->
            case stepFromFront d pages of
                Just ( _, aid, _ ) ->
                    goTo aid m

                Nothing ->
                    ( { m | notice = "The text opens after the front matter" }, Cmd.none )


stepFromFront : Int -> List ( Int, String, Int ) -> Maybe ( Int, String, Int )
stepFromFront d pages =
    if d > 0 then
        List.head pages

    else
        Nothing


pagePosition : List ( Int, String, Int ) -> Int -> Maybe Int
pagePosition pages pg =
    List.indexedMap Tuple.pair pages
        |> List.filter (\( _, ( _, _, p ) ) -> p == pg)
        |> List.head
        |> Maybe.map Tuple.first


stepSection : Int -> Model -> ( Model, Cmd Msg )
stepSection d m =
    let
        toc =
            tocIds m
    in
    case currentSection m of
        Just sid ->
            case List.indexedMap Tuple.pair toc |> List.filter (\( _, s ) -> s == sid) |> List.head of
                Just ( i, _ ) ->
                    case List.head (List.drop (i + d) toc) of
                        Just nxt ->
                            goTo nxt m

                        Nothing ->
                            ( { m
                                | notice =
                                    if d > 0 then
                                        "This is the last section — the notes and the end matter follow it"

                                    else
                                        "This is the first section — the front matter is before it"
                              }
                            , Cmd.none
                            )

                Nothing ->
                    ( m, Cmd.none )

        Nothing ->
            if d > 0 then
                case tocIds m |> List.head of
                    Just first ->
                        goTo first m

                    Nothing ->
                        ( m, Cmd.none )

            else
                ( { m | notice = "This is the front matter — the first section follows it" }, Cmd.none )


stepHit : Int -> Model -> ( Model, Cmd Msg )
stepHit d m =
    if List.isEmpty m.hits then
        ( m, Cmd.none )

    else
        let
            n =
                List.length m.hits

            ix =
                modBy n (m.hitIx + d)

            entryIx =
                Maybe.withDefault 0 (List.head (List.drop ix m.hits))

            m1 =
                { m | hitIx = ix, posIx = entryIx }
        in
        case List.head (List.drop entryIx m.entries) of
            Just e ->
                let
                    aid =
                        entryAnchor e
                in
                if String.isEmpty aid then
                    ( m1, jumpTo ("rd-main") )

                else
                    ( m1, Cmd.batch [ jumpTo aid, setHash aid ] )

            Nothing ->
                ( m1, Cmd.none )



{- ---------- search ---------- -}


search : String -> Model -> Model
search q m =
    if String.length (String.trim q) < 2 then
        { m | q = q, hits = [], hitIx = 0 }

    else
        let
            needle =
                String.toLower (String.trim q)

            hits =
                m.entries
                    |> List.indexedMap Tuple.pair
                    |> List.filterMap
                        (\( ix, e ) ->
                            -- THE TEXT PROPER is the body and the notes. Everything
                            -- else is the volume's apparatus: the front matter, the
                            -- printer's colophon, the publisher's list, the library's
                            -- own marks. A positive test names what is searched, so a
                            -- new region kind is excluded by default, not by memory.
                            if isProse e.item && (e.region == "body" || e.region == "notes") then
                                if String.contains needle (String.toLower (shownText m e.item)) then
                                    Just ix

                                else
                                    Nothing

                            else
                                Nothing
                        )
        in
        { m | q = q, hits = hits, hitIx = 0 }


isProse : Flow -> Bool
isProse f =
    case f of
        FPara _ ->
            True

        FNote _ ->
            True

        _ ->
            False


{-| The text as the reader sees it: the reading view's repairs applied, or the
transcription's own characters. The two views are two texts, and a search is a
search of the one in front of you. -}
shownText : Model -> Flow -> String
shownText m f =
    let
        raw =
            case f of
                FPara pr ->
                    String.join "" (List.map inlineText pr.parts)

                FNote n ->
                    String.join " " n.texts

                _ ->
                    ""
    in
    if m.view == Reading then
        Doc.applyCorrections (docRules m) raw

    else
        raw


inlineText : Inline -> String
inlineText i =
    case i of
        IText s ->
            s

        IVerse s ->
            String.replace "\n" " " s

        IRef _ label _ ->
            label

        -- the page marker and the running head are ANNOTATIONS, not the text:
        -- counting them would put the page number in the search, and a running
        -- head is furniture the reading view suppresses
        IPage _ _ _ _ ->
            ""

        IRh _ ->
            ""


docRules : Model -> List Correction
docRules m =
    m.doc |> Maybe.map .corrections |> Maybe.withDefault []



{- ---------- anchors and derived state ---------- -}


buildAnchors : List Entry -> Dict String Int
buildAnchors entries =
    entries
        |> List.indexedMap Tuple.pair
        |> List.foldl (\( ix, e ) acc -> addAnchors ix e acc) Dict.empty


addAnchors : Int -> Entry -> Dict String Int -> Dict String Int
addAnchors ix e acc =
    let
        put k d =
            if String.isEmpty k then
                d

            else
                Dict.insert k ix d
    in
    case e.item of
        FRegion _ rid ->
            put (Maybe.withDefault "" rid) acc

        FSec _ sid _ ->
            put sid acc

        FPage _ _ pid _ ->
            put (Maybe.withDefault "" pid) acc

        FNote n ->
            put (Maybe.withDefault "" n.id) acc

        FPara pr ->
            List.foldl
                (\i a ->
                    case i of
                        IRef _ _ rid ->
                            put rid a

                        IPage _ _ (Just pid) _ ->
                            -- a page marker that sits INSIDE a paragraph still
                            -- carries the #p<n> anchor
                            put pid a

                        _ ->
                            a
                )
                (put (Maybe.withDefault "" pr.id) acc)
                pr.parts

        _ ->
            acc


anchorAt : Model -> Int -> String
anchorAt m ix =
    List.drop ix m.entries |> List.head |> Maybe.map entryAnchor |> Maybe.withDefault ""


entryAnchor : Entry -> String
entryAnchor e =
    case e.item of
        FRegion _ rid ->
            Maybe.withDefault "" rid

        FSec _ sid _ ->
            sid

        FPage _ _ pid _ ->
            Maybe.withDefault "" pid

        FNote n ->
            Maybe.withDefault ("n" ++ String.fromInt n.n) n.id

        FPara pr ->
            case pr.id of
                Just pid ->
                    pid

                Nothing ->
                    List.foldl
                        (\i acc ->
                            case i of
                                IRef _ _ rid ->
                                    rid

                                _ ->
                                    acc
                        )
                        ""
                        pr.parts

        _ ->
            ""


{-| Every printed page in document order, with the entry it sits in and its
anchor. Since the page markers moved INSIDE the paragraph that runs across the
page turn, a page is no longer its own entry — it is a marker inside a paragraph
— so the index walks the paragraph's inlines as well as the standalone markers.
`parts` accumulate back-to-front, so the inline pages are reversed into document
order. -}
pageIndex : List Entry -> List ( Int, String, Int )
pageIndex entries =
    entries
        |> List.indexedMap Tuple.pair
        |> List.concatMap
            (\( ix, e ) ->
                case e.item of
                    FPage (Just pg) _ (Just pid) _ ->
                        [ ( ix, pid, pg ) ]

                    FPara pr ->
                        -- `pr.parts` is ALREADY in document order (the grouping
                        -- reverses the accumulator when it closes), so the inline
                        -- pages come out in order; reversing them is what put the
                        -- paragraph's LAST page first (MEASURED: #p15 reported p.17)
                        List.filterMap
                            (\i ->
                                case i of
                                    IPage (Just pg) _ (Just pid) _ ->
                                        Just ( ix, pid, pg )

                                    _ ->
                                        Nothing
                            )
                            pr.parts

                    _ ->
                        []
            )


tocIds : Model -> List String
tocIds m =
    m.doc |> Maybe.map (\d -> List.map .id d.toc) |> Maybe.withDefault []


currentPage : Model -> Maybe Int
currentPage m =
    case m.atPage of
        Just p ->
            Just p

        Nothing ->
            pageAt m m.posIx


currentSection : Model -> Maybe String
currentSection m =
    sectionAt m m.posIx


{-| The printed page and the division at ANY entry, not only at the reader's
position: the citation panel asks the same question about the passage it froze
when it opened, and deriving it from the position would make the citation follow
the scroll instead of the passage. -}
pageAt : Model -> Int -> Maybe Int
pageAt m ix =
    let
        pages =
            pageIndex m.entries
    in
    case ( List.drop ix m.entries |> List.head |> Maybe.map .item, List.filter (\( ei, _, _ ) -> ei < ix) pages |> List.reverse |> List.head ) of
        -- standing ON a page marker is that page
        ( Just (FPage pg _ _ _), _ ) ->
            pg

        -- a PARAGRAPH stands on the page it STARTS on: the last page marker BEFORE
        -- it. Its own inline markers are the pages it runs ONTO (MEASURED: reading
        -- the first marker inside the entry reported p. 15 for a paragraph that
        -- starts on p. 14, because the marker inside it was the p.15 turn)
        ( _, Just ( _, _, pg ) ) ->
            Just pg

        -- a paragraph with no marker before it (the front matter): its own first
        -- inline page, if it has one
        _ ->
            List.filter (\( ei, _, _ ) -> ei == ix) pages
                |> List.head
                |> Maybe.map (\( _, _, pg ) -> pg)


sectionAt : Model -> Int -> Maybe String
sectionAt m ix =
    List.take (ix + 1) m.entries
        |> List.reverse
        |> List.filterMap
            (\e ->
                case e.item of
                    FSec _ sid _ ->
                        Just sid

                    _ ->
                        Nothing
            )
        |> List.head


noteLanguages : List Entry -> Dict Int String
noteLanguages entries =
    entries
        |> List.filterMap
            (\e ->
                case e.item of
                    FNote n ->
                        n.lang |> Maybe.map (\l -> ( n.n, l ))

                    _ ->
                        Nothing
            )
        |> Dict.fromList


positionLabel : Model -> String
positionLabel m =
    let
        pg =
            currentPage m |> Maybe.map (\n -> "p. " ++ String.fromInt n) |> Maybe.withDefault "the front matter"

        sec =
            currentSection m |> Maybe.map (\s -> " · §" ++ String.dropLeft 1 s) |> Maybe.withDefault ""
    in
    pg ++ sec


{-| The share of the text read: the position over every entry of the text
proper. The front matter and the end matter are excluded by the region marks
— which is the whole reason those marks are in the document: a reader who has
finished the notes has finished the book, whatever the publisher's catalogue
after it says. -}
progress : Model -> Int
progress m =
    let
        counted =
            m.entries
                |> List.indexedMap Tuple.pair
                |> List.filter (\( _, e ) -> e.region == "body" || e.region == "notes")

        -- THE SHARE IS OF THE TEXT, by its LENGTH. Counting ENTRIES instead made
        -- the meter a function of how the blocks are grouped: the same reader at
        -- section 9 read 36% when every block and page marker was an entry, and
        -- 20% after the paragraphs were joined — same text, same place, a third
        -- less "read". A length is what "% read" means, and it does not move when
        -- the grouping does (MEASURED: 39% by length at section 9, the same place).
        size ( _, e ) =
            String.length (shownText m e.item)

        done =
            counted
                |> List.filter (\( ix, _ ) -> ix <= m.posIx)
                |> List.map size
                |> List.sum

        total =
            counted |> List.map size |> List.sum
    in
    if total == 0 then
        0

    else
        round (100 * toFloat done / toFloat total)


{- ---------- subscriptions ---------- -}


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.batch
        [ docReceived GotDoc
        , docFailed DocLoadFailed
        , hashChanged HashIn
        , scrolled ScrolledTo
        ]



{- ---------- view ---------- -}


hashOf : String -> String
hashOf h =
    if String.startsWith "#" h then
        String.dropLeft 1 h

    else
        h


view : Model -> Html Msg
view m =
    -- the id is on the ROOT the app renders, not only on the mount node: Elm's
    -- Browser.element takes the mount node over (it virtualizes it and patches
    -- it), so the served <div id="reader-app"></div> is REPLACED by this element.
    -- A page that looks the app up by id afterwards must find it here.
    div [ id "reader-app", class ("rd scale-" ++ String.fromInt m.scale), Ev.on "keydown" keyDecoder ]
        [ if m.failed then
            div [ class "rd-status" ]
                [ p [] [ text "The text could not be loaded here." ]
                , p []
                    [ text "Nothing is lost by that: the whole transcription is served as one plain file that needs no scripts at all — "
                    , a [ href (m.base ++ "plain") ] [ text "read it as plain text" ]
                    , text "."
                    ]
                ]

          else
            case m.doc of
                Nothing ->
                    div [ class "rd-status" ] [ p [] [ text "Loading the text…" ] ]

                Just doc ->
                    div []
                        [ bar m
                        , div [ class "rd-cols" ]
                            [ contents m
                            , main_
                                [ id "rd-main", class "rd-main", attribute "tabindex" "0" ]
                                [ flow m doc ]
                            ]
                        , footer [ class "rd-foot" ]
                            [ a [ href (m.base ++ "plain") ] [ text "the whole text as one plain file" ]
                            , span [ class "rd-sep" ] [ text " · " ]
                            , a [ href m.base ] [ text "the edition and its provenance" ]
                            ]
                        , popover m
                        , citePanel m
                        , rulesPanel m doc
                        , statusLine m
                        ]
        ]



{-| A link inside the app: the app owns the fragment (one writer), so the
browser's own navigation is prevented and the jump is made once, by the model. -}
linkTo : String -> String -> Html Msg
linkTo aid label =
    a
        [ href ("#" ++ aid)
        , Ev.preventDefaultOn "click" (D.succeed ( GoAnchor aid, True ))
        ]
        [ text label ]


{-| Does this fragment name a note? A link to a note is a link into the notes,
so arriving at one opens it as well as scrolling to it. -}
noteOf : String -> Maybe Int
noteOf aid =
    if String.startsWith "n" aid && String.length aid > 1 then
        String.dropLeft 1 aid |> String.toInt

    else
        Nothing


keyDecoder : D.Decoder Msg
keyDecoder =
    D.map2 Key
        (D.field "key" D.string)
        (D.field "shiftKey" D.bool)


enterDecoder : D.Decoder Msg
enterDecoder =
    D.field "key" D.string
        |> D.andThen
            (\k ->
                if k == "Enter" then
                    D.succeed JumpGo

                else
                    D.fail "not Enter"
            )


bar : Model -> Html Msg
bar m =
    header [ class "rd-bar" ]
        [ button
            [ id "rd-drawer-btn"
            , type_ "button"
            , class "rd-btn rd-drawer-btn"
            , attribute "aria-expanded" (bool m.drawer)
            , attribute "aria-controls" "rd-nav"
            , Ev.onClick DrawerToggle
            ]
            [ text (if m.drawer then "✕ contents" else "☰ contents") ]
        , div [ class "rd-views", attribute "role" "group", attribute "aria-label" "Which text" ]
            -- THE TWO BUTTONS SAY WHICH VIEW HAS THE REPAIRS. They used to read
            -- "reading" and "transcription", and a reader who asked where the
            -- repaired text was asked it while looking at this view — the label
            -- named neither the difference nor the default. The ids, the
            -- aria-pressed state and the stored names are unchanged; the visible
            -- text now states what the button does.
            [ button
                [ type_ "button", class "rd-btn"
                , attribute "aria-pressed" (bool (m.view == Reading))
                , Ev.onClick (ViewSet Reading)
                ]
                [ text "repaired" ]
            , button
                [ type_ "button", class "rd-btn"
                , attribute "aria-pressed" (bool (m.view == Transcription))
                , Ev.onClick (ViewSet Transcription)
                ]
                [ text "as scanned" ]
            ]
        , div [ class "rd-search" ]
            [ label [ class "rd-vh", A.for "rd-q" ] [ text "Search this text" ]
            , input
                [ id "rd-q", type_ "search", value m.q, placeholder "search this text"
                , Ev.onInput Query
                , Ev.onFocus (Typing True)
                , Ev.onBlur (Typing False)
                ]
                []
            , span [ class "rd-count", attribute "aria-live" "polite" ]
                [ text
                    (if String.isEmpty (String.trim m.q) then
                        ""

                     else if List.isEmpty m.hits then
                        "no match"

                     else
                        -- the count is over the passages that hold the query, not
                        -- over every occurrence: a passage is what next/prev steps
                        -- between, so the number names the thing it counts
                        String.fromInt (m.hitIx + 1)
                            ++ " of "
                            ++ String.fromInt (List.length m.hits)
                            ++ (if List.length m.hits == 1 then
                                    " passage"
                                else
                                    " passages"
                               )
                    )
                ]
            , button [ type_ "button", class "rd-btn", Ev.onClick (HitStep -1), disabled (List.isEmpty m.hits), attribute "aria-label" "Previous match" ] [ text "↑" ]
            , button [ type_ "button", class "rd-btn", Ev.onClick (HitStep 1), disabled (List.isEmpty m.hits), attribute "aria-label" "Next match" ] [ text "↓" ]
            ]
        , pager m
        , div [ class "rd-bar-right" ]
            [ button [ type_ "button", class "rd-btn", attribute "aria-pressed" (bool m.cite), Ev.onClick CiteToggle ] [ text "cite" ]
            , button [ id "rd-rules-btn", type_ "button", class "rd-btn", attribute "aria-pressed" (bool m.showRules), Ev.onClick RulesToggle ] [ text ("repairs (" ++ String.fromInt (List.length (docRules m)) ++ ")") ]
            , button [ type_ "button", class "rd-btn", Ev.onClick (ScaleSet (m.scale - 1)), attribute "aria-label" "Smaller text" ] [ text "A−" ]
            , button [ type_ "button", class "rd-btn", Ev.onClick (ScaleSet (m.scale + 1)), attribute "aria-label" "Larger text" ] [ text "A+" ]
            ]
        ]


bool : Bool -> String
bool b =
    if b then
        "true"

    else
        "false"


pager : Model -> Html Msg
pager m =
    let
        pages =
            pageIndex m.entries

        total =
            List.length pages

        here =
            case currentPage m of
                Just pg ->
                    "page " ++ String.fromInt (Maybe.withDefault 0 (pagePosition pages pg) + 1) ++ " of " ++ String.fromInt total

                Nothing ->
                    "before the numbered pages"
    in
    div [ class "rd-pager" ]
        [ button [ type_ "button", class "rd-btn", attribute "aria-label" "Previous section", Ev.onClick (Key "ArrowLeft" True) ] [ text "«" ]
        , button [ type_ "button", class "rd-btn", attribute "aria-label" "Previous printed page", Ev.onClick (Key "ArrowLeft" False) ] [ text "‹" ]
        , label [ class "rd-vh", A.for "rd-jump" ] [ text "Jump to printed page" ]
        , input
            [ id "rd-jump", type_ "text", class "rd-jump", value m.jump, placeholder "page"
            , Ev.onInput JumpInput
            , Ev.onFocus (Typing True)
            , Ev.onBlur (Typing False)
            , Ev.on "keydown" enterDecoder
            ]
            []
        , button [ type_ "button", class "rd-btn", Ev.onClick JumpGo ] [ text "go" ]
        , button [ type_ "button", class "rd-btn", attribute "aria-label" "Next printed page", Ev.onClick (Key "ArrowRight" False) ] [ text "›" ]
        , button [ type_ "button", class "rd-btn", attribute "aria-label" "Next section", Ev.onClick (Key "ArrowRight" True) ] [ text "»" ]
        , span [ class "rd-here", attribute "aria-live" "polite" ] [ text (positionLabel m ++ " · " ++ here) ]
        ]


contents : Model -> Html Msg
contents m =
    nav
        [ id "rd-nav"
        , class ("rd-nav" ++ (if m.drawer then " rd-nav-open" else ""))
        , attribute "aria-label" "Contents and marks"
        ]
        [ progressMeter m
        , div [ class "rd-nav-actions" ]
            [ button [ type_ "button", class "rd-btn", Ev.onClick BookmarkAdd ] [ text "bookmark this spot" ]
            , button [ type_ "button", class "rd-btn", Ev.onClick DrawerClose ] [ text "close" ]
            ]
        , h3 [] [ text "Contents" ]
        , ul [ class "rd-toc" ] (tocItems m)
        , h3 [] [ text "Marks" ]
        , if List.isEmpty m.stored.bookmarks then
            p [ class "rd-dim" ] [ text "Nothing bookmarked yet. A mark keeps its own anchor, so it keeps working after a rebuild." ]

          else
            ul [ class "rd-marks" ]
                (List.map
                    (\bm ->
                        li []
                            [ linkTo bm.id bm.label
                            , button [ type_ "button", class "rd-btn rd-x", Ev.onClick (BookmarkRemove bm.id), attribute "aria-label" ("Remove the mark at " ++ bm.label) ] [ text "✕" ]
                            ]
                    )
                    m.stored.bookmarks
                )
        , h3 [] [ text "Printed pages" ]
        , ol [ class "rd-pages" ]
            (List.map
                (\( _, pid, pg ) ->
                    li [ class (if currentPage m == Just pg then "rd-cur" else "") ]
                        [ linkTo pid (String.fromInt pg)
                        ]
                )
                (pageIndex m.entries)
            )
        ]


progressMeter : Model -> Html Msg
progressMeter m =
    let
        pct =
            progress m
    in
    div [ class "rd-progress" ]
        [ div [ class "rd-progress-track" ]
            [ div [ class "rd-progress-fill", A.style "width" (String.fromInt pct ++ "%") ] [] ]
        , span [ class "rd-progress-label", attribute "data-progress" (String.fromInt pct) ]
            [ text (String.fromInt pct ++ "% read — the front matter and the end matter are not counted") ]
        ]


tocItems : Model -> List (Html Msg)
tocItems m =
    case m.doc of
        Nothing ->
            []

        Just doc ->
            let
                cur =
                    currentSection m

                regions =
                    doc.blocks
                        |> List.filterMap
                            (\b ->
                                case b of
                                    BRegion kind (Just rid) ->
                                        Just { id = rid, label = regionLabel kind, page = Nothing, damagedWords = Nothing }

                                    _ ->
                                        Nothing
                            )

                sections =
                    -- The contents list is generated apparatus (the print has no
                    -- contents page), so it exists to be read, and it carries the
                    -- GENERATED title — the division's opening words with the
                    -- recorded repairs applied — because damaged words on the one
                    -- line a reader uses to decide whether to read on cost a
                    -- section. The transcription view shows `raw`: the same words
                    -- with no rule applied, which is the transcription's own
                    -- title, and the difference between the two views in one line.
                    --
                    -- A title the repairs could not restore is not shown at all:
                    -- both views state the gap, and the transcription's own words
                    -- stand beside the statement in a dim span. Neither view
                    -- invents a title.
                    List.map
                        (\t ->
                            { id = t.id
                            , label =
                                String.fromInt t.n
                                    ++ " · "
                                    ++ (if t.damaged then
                                            damagedTitle

                                        else if m.view == Reading then
                                            t.title

                                        else
                                            t.raw
                                       )
                            , page = t.page
                            , damagedWords =
                                if t.damaged then
                                    Just t.raw

                                else
                                    Nothing
                            }
                        )
                        doc.toc
            in
            List.map (tocLink cur) (regions ++ sections)


{-| One row of the contents list. The regions have no page and no damaged words;
the divisions carry both. -}
type alias TocItem =
    { id : String, label : String, page : Maybe Int, damagedWords : Maybe String }


tocLink : Maybe String -> TocItem -> Html Msg
tocLink cur item =
    li [ class (if cur == Just item.id then "rd-cur" else "") ]
        [ a [ href ("#" ++ item.id), Ev.on "click" (D.succeed (GoAnchor item.id)) ]
            [ text item.label
            , case item.page of
                Just p ->
                    span [ class "rd-toc-page" ] [ text (" p. " ++ String.fromInt p) ]

                Nothing ->
                    text ""
            ]
        , case item.damagedWords of
            Just words_ ->
                -- the transcription's own words, so the reader can see what the
                -- title would have been without being offered it as one
                div [ class "rd-toc-raw" ] [ text ("the transcription reads “" ++ words_ ++ "”") ]

            Nothing ->
                text ""
        ]


{-| The one sentence the contents list shows in place of a title the
transcription damaged and the repairs cannot restore. It is stated, never
repaired: inventing a title is inventing a reading. The shell carries the same
sentence (tools/build.mjs), and the app smoke asserts they are the same one.
-}
damagedTitle : String
damagedTitle =
    "[the opening words are damaged in this transcription]"


regionLabel : String -> String
regionLabel kind =
    case kind of
        "front" ->
            "The front matter"

        "notes" ->
            "Notes"

        "colophon" ->
            "The printer’s colophon"

        "end" ->
            "The publisher’s book list"

        "library" ->
            "The library’s marks"

        _ ->
            "The text"


flow : Model -> Doc -> Html Msg
flow m doc =
    let
        printed =
            notesInPrint m

        step : ( Int, Entry ) -> ( Maybe Int, List (Html Msg) ) -> ( Maybe Int, List (Html Msg) )
        step ( ix, e ) ( curPg, acc ) =
            let
                -- THE PAGES THIS ENTRY STANDS ON. A paragraph the page turn runs
                -- through stands on several (its inline page markers), so the
                -- page that decides the range is not one number: the entry is in
                -- range when ANY of its pages is. Reading only the last FPage
                -- before it left a paragraph that starts on page 5 and runs onto
                -- 15 marked OUT of a 15-15 range.
                inlinePages =
                    case e.item of
                        FPara pr ->
                            List.filterMap
                                (\i ->
                                    case i of
                                        IPage (Just p) _ _ _ ->
                                            Just p

                                        _ ->
                                            Nothing
                                )
                                pr.parts

                        FPage (Just p) _ _ _ ->
                            [ p ]

                        _ ->
                            []

                pages =
                    (case curPg of
                        Just p ->
                            [ p ]

                        Nothing ->
                            []
                    )
                        ++ inlinePages

                last =
                    case List.head (List.reverse inlinePages) of
                        Just p ->
                            Just p

                        Nothing ->
                            curPg

                inRange =
                    case m.range of
                        Just ( a, b ) ->
                            case e.item of
                                -- A note is kept when its REFERENCE is kept: the
                                -- notes print as endnotes, at the back, so a
                                -- range that holds a passage holds the note that
                                -- passage refers to.
                                FNote n ->
                                    Set.member n.n printed

                                _ ->
                                    List.any (\p -> p >= a && p <= b) pages

                        Nothing ->
                            True
            in
            ( last, itemView m doc ix e inRange :: acc )
    in
    div [ class "rd-flow" ]
        (List.reverse (Tuple.second (List.foldl step ( Nothing, [] ) (List.indexedMap Tuple.pair m.entries))))


{-| The notes a print carries: with no range, every note (the endnotes are the
book's own); with a range, the notes whose references stand on a page inside it,
plus any note definition whose own page is inside it — the second half of the
rule keeps a note that spans the range (note 6 spans printed pages 43–44) printed
wherever it is asked for, so the change can only ADD notes to a print, never take
one away. -}
notesInPrint : Model -> Set Int
notesInPrint m =
    case m.range of
        Nothing ->
            Set.fromList (Dict.keys m.notes)

        Just ( a, b ) ->
            let
                inRange p =
                    case p of
                        Just n ->
                            n >= a && n <= b

                        Nothing ->
                            False
            in
            m.entries
                |> List.foldl
                    (\e ( pg, set ) ->
                        let
                            pg0 =
                                case e.item of
                                    FPage (Just p) _ _ _ ->
                                        Just p

                                    _ ->
                                        pg
                        in
                        case e.item of
                            FNote n ->
                                ( pg0
                                , if inRange pg0 then
                                    Set.insert n.n set

                                  else
                                    set
                                )

                            FPara pr ->
                                -- the page moves WITHIN the paragraph: a page
                                -- marker inside it (IPage) changes the page the
                                -- refs after it stand on, which is what the range
                                -- asks about. Reading only the entry's page left
                                -- every ref in a page-spanning paragraph on the
                                -- page the paragraph STARTED on.
                                List.foldl
                                    (\i ( pg1, s1 ) ->
                                        case i of
                                            IPage (Just p) _ _ _ ->
                                                ( Just p, s1 )

                                            IRef n _ _ ->
                                                ( pg1
                                                , if inRange pg1 then
                                                    Set.insert n s1

                                                  else
                                                    s1
                                                )

                                            _ ->
                                                ( pg1, s1 )
                                    )
                                    ( pg0, set )
                                    pr.parts

                            _ ->
                                ( pg0, set )
                    )
                    ( Nothing, Set.empty )
                |> Tuple.second


itemView : Model -> Doc -> Int -> Entry -> Bool -> Html Msg
itemView m doc ix e inRange =
    let
        rgn =
            "rd-in-" ++ e.region

        cls =
            if inRange then
                "rd-item " ++ rgn

            else
                "rd-item rd-out " ++ rgn

        mark =
            attribute "data-rd-i" (String.fromInt ix)

        txt s =
            if m.view == Reading then
                Doc.applyCorrections doc.corrections s

            else
                s
    in
    case e.item of
        FRegion kind rid ->
            case rid of
                Just r ->
                    section [ id r, mark, class ("rd-region " ++ cls) ] [ h2 [] [ text (regionLabel kind) ] ]

                Nothing ->
                    section [ mark, class ("rd-region " ++ cls) ] [ h2 [] [ text (regionLabel kind) ] ]

        FSec n sid pg ->
            section [ id sid, mark, class ("rd-sec " ++ cls) ]
                [ h2 []
                    [ span [ class "rd-sec-n" ] [ text (String.fromInt n) ]
                    , case pg of
                        Just p ->
                            span [ class "rd-sec-page", title ("This section opens on printed page " ++ String.fromInt p) ]
                                [ text ("  p. " ++ String.fromInt p) ]

                        Nothing ->
                            text ""
                    ]
                ]

        FPage pg how pid raw ->
            span [ mark, class ("rd-item rd-pb-wrap " ++ cls) ] [ pageMark pg how pid raw ]

        FRh x ->
            if m.view == Transcription then
                div [ mark, class ("rd-rh " ++ cls) ] [ text x ]

            else
                text ""

        FNote n ->
            let
                nid =
                    Maybe.withDefault ("n" ++ String.fromInt n.n) n.id

                langAttr =
                    case n.lang of
                        Just l ->
                            [ A.lang l ]

                        Nothing ->
                            []
            in
            div
                [ id nid
                , mark
                , class ("rd-note " ++ cls ++ (if m.open == Just n.n then " rd-note-open" else ""))
                ]
                [ span [ class "rd-note-n" ] [ text (String.fromInt n.n) ]
                , div ([ class "rd-note-body" ] ++ langAttr)
                    (damageSpans doc m (txt (String.join " " n.texts)))
                -- The way back is its OWN grid row, in the text column. MEASURED
                -- in a print rendering: as a bare third child it was placed in the
                -- note-number column, which is 2rem wide, so the link wrapped one
                -- word per line ("back / to / the / reference / (8)") in the
                -- printed notes.
                , div [ class "rd-note-back" ] [ linkTo ("r" ++ String.fromInt n.n) ("back to the reference (" ++ String.fromInt n.n ++ ")") ]
                ]

        FPara pr ->
            let
                attrs =
                    class ("rd-p " ++ cls ++ (if List.member ix m.hits && List.member ix (hitEntries m) then " rd-hit" else ""))

                pid =
                    case pr.id of
                        Just p ->
                            [ id p ]

                        Nothing ->
                            []
            in
            p (pid ++ [ mark, attrs ]) (List.map (inlineView m doc) pr.parts)


hitEntries : Model -> List Int
hitEntries m =
    m.hits


inlineView : Model -> Doc -> Inline -> Html Msg
inlineView m doc i =
    let
        txt s =
            if m.view == Reading then
                Doc.applyCorrections doc.corrections s

            else
                s
    in
    case i of
        IText s ->
            span [] (damageSpans doc m (txt s))

        IVerse s ->
            span [ class "rd-verse" ]
                (List.indexedMap
                    (\k line ->
                        if k == 0 then
                            span [] (damageSpans doc m (txt line))

                        else
                            span [] (br [] [] :: damageSpans doc m (txt line))
                    )
                    (String.split "\n" s)
                )

        IPage pg how idv raw ->
            -- the page boundary as it sits in the print: a marker INSIDE the
            -- paragraph, where the page turns
            pageMark pg how idv raw

        IRh x ->
            if m.view == Transcription then
                span [ class "rd-rh-inline" ] [ text x ]

            else
                text ""

        IRef n _ rid ->
            -- the superscript and the margin copy are SIBLINGS, not nested: the
            -- margin note FLOATS against the paragraph (a float inside a sup is
            -- positioned against the sup, and the note lands on top of the line
            -- it annotates — MEASURED in a render). Floating it lets the text
            -- flow beside it, which is what a margin note is.
            span [ class "rd-refwrap" ]
                [ sup [ class "rd-ref" ]
                    [ a
                        [ id (Maybe.withDefault ("r" ++ String.fromInt n) (nonEmpty rid))
                        , href ("#n" ++ String.fromInt n)
                        , title ("Note " ++ String.fromInt n)
                        , Ev.preventDefaultOn "click" (D.succeed ( NoteOpen n, True ))
                        ]
                        [ text (String.fromInt n) ]
                    ]
                , case Dict.get n m.notes of
                    Just t ->
                        span [ class "rd-margin", attribute "aria-hidden" "true" ]
                            [ span [ class "rd-margin-n" ] [ text (String.fromInt n) ]
                            , text " "
                            , span [] (damageSpans doc m (txt t))
                            ]

                    Nothing ->
                        text ""
                ]


nonEmpty : String -> Maybe String
nonEmpty s =
    if String.isEmpty s then
        Nothing

    else
        Just s


pageMark : Maybe Int -> String -> Maybe String -> Maybe String -> Html Msg
pageMark pg how pid raw =
    case ( pg, pid ) of
        ( Just p, Just idv ) ->
            span
                [ id idv
                , class ("rd-pb" ++ (if how == "interpolated" then " rd-pb-interp" else ""))
                , attribute "data-page" (String.fromInt p)
                , title
                    (if how == "interpolated" then
                        "Printed page " ++ String.fromInt p ++ ", read from the page sequence"

                     else
                        "Printed page " ++ String.fromInt p
                    )
                ]
                [ text (String.fromInt p) ]

        ( Nothing, _ ) ->
            -- A page the extraction REFUSED to number. The transcription's own
            -- characters are shown, and the marker says what they are: a number
            -- that could not be read is a finding, and inventing one (or dropping
            -- the marker) would hide it. The volume has no leaf numbers in this
            -- mode (leaf is null throughout — the txt-mode document), so "leaf N"
            -- is not available to show; the transcription's own characters are.
            span
                [ class "rd-pb rd-pb-refused"
                , attribute "data-page" "refused"
                , title
                    ("This page marker could not be read as a number; the transcription has "
                        ++ (case raw of
                                Just x ->
                                    "\"" ++ x ++ "\""

                                Nothing ->
                                    "nothing"
                           )
                        ++ " here"
                    )
                ]
                [ case raw of
                    Just x ->
                        text ("[" ++ x ++ "")

                    Nothing ->
                        text "["
                , span [ class "rd-vh" ] [ text " — this page number could not be read, so no number is shown" ]
                , text "]"
                ]

        ( Just p, Nothing ) ->
            span [ class "rd-pb", attribute "data-page" (String.fromInt p) ] [ text (String.fromInt p) ]


{-| THE READING VIEW'S RENDERING OF THE DAMAGE THAT IS LEFT (plan §7(d)).

The base policy substitutes a reading where one is recorded and otherwise leaves
the transcription's own characters. Leaving them is only honest if the reader can
SEE that they are damage rather than a typo by the author, so every character of
the document's damage set that survives into the reading view is marked, and the
repairs panel names the words they belong to. The transcription view is not
marked: it is the verbatim text, and everything in it is the transcription's.

A document built before the policy carries no damage set, and then nothing is
marked — the reading view shows what it always showed, and no claim is made.
-}
damageSpans : Doc -> Model -> String -> List (Html Msg)
damageSpans doc m s =
    if m.view /= Reading || String.isEmpty doc.damage then
        highlight m s

    else
        List.concatMap
            (\( isDam, chunk ) ->
                if isDam then
                    [ mark
                        [ class "rd-damage"
                        , title "damage in the transcription here — no reading is recorded for this word"
                        ]
                        [ text chunk ]
                    ]

                else
                    highlight m chunk
            )
            (damagePieces doc.damage s)


{-| Split a string into runs that ARE a damage character and runs that are not,
in order. -}
damagePieces : String -> String -> List ( Bool, String )
damagePieces damage s =
    let
        isDam c =
            String.contains (String.fromChar c) damage

        step c ( acc, prevDam, buf ) =
            let
                d =
                    isDam c
            in
            if buf == "" then
                ( acc, d, String.fromChar c )

            else if d == prevDam then
                ( acc, d, buf ++ String.fromChar c )

            else
                ( ( prevDam, buf ) :: acc, d, String.fromChar c )

        ( done, tailDam, tailBuf ) =
            String.foldl step ( [], False, "" ) s
    in
    List.reverse
        (if tailBuf == "" then
            done

         else
            ( tailDam, tailBuf ) :: done
        )


{-| Every occurrence of the query, marked; the reading view's own text is the
text searched, so a hit is a hit on what the reader sees. -}
highlight : Model -> String -> List (Html Msg)
highlight m s =
    let
        q =
            String.trim m.q
    in
    if String.length q < 2 then
        [ text s ]

    else
        List.map
            (\( isHit, chunk ) ->
                if isHit then
                    mark [] [ text chunk ]

                else
                    text chunk
            )
            (pieces q s)


pieces : String -> String -> List ( Bool, String )
pieces q s =
    let
        qlen =
            String.length q

        body =
            String.indexes (String.toLower q) (String.toLower s)
    in
    if List.isEmpty body then
        [ ( False, s ) ]

    else
        let
            step_ i ( from, sofar ) =
                let
                    pre =
                        String.slice from i s

                    hit =
                        String.slice i (i + qlen) s
                in
                ( i + qlen
                , if String.isEmpty pre then
                    ( True, hit ) :: sofar

                  else
                    ( True, hit ) :: ( False, pre ) :: sofar
                )

            ( last, acc ) =
                List.foldl step_ ( 0, [] ) body

            tail =
                String.slice last (String.length s) s
        in
        List.reverse
            (if String.isEmpty tail then
                acc

             else
                ( False, tail ) :: acc
            )


popover : Model -> Html Msg
popover m =
    case m.open of
        Nothing ->
            text ""

        Just n ->
            let
                langAttr =
                    case Dict.get n m.noteLangs of
                        Just l ->
                            [ A.lang l ]

                        Nothing ->
                            []
            in
            div
                [ id "rd-pop"
                , class "rd-pop"
                , attribute "role" "dialog"
                , attribute "tabindex" "-1"
                , attribute "aria-label" ("Note " ++ String.fromInt n)
                , attribute "data-note" (String.fromInt n)
                ]
                [ div [ class "rd-pop-head" ]
                    [ strong [] [ text ("Note " ++ String.fromInt n) ]
                    , button [ type_ "button", class "rd-btn", Ev.onClick (NoteClose n), attribute "aria-label" "Close the note" ] [ text "✕" ]
                    ]
                , div ([ class "rd-pop-body" ] ++ langAttr)
                    [ text (Maybe.withDefault "" (Dict.get n m.notes)) ]
                , div [ class "rd-pop-foot" ]
                    [ linkTo ("n" ++ String.fromInt n) "the note in the list"
                    , button [ type_ "button", class "rd-btn", Ev.onClick (NoteBack n) ] [ text ("return to the reference of note " ++ String.fromInt n) ]
                    ]
                ]


{-| Cite this passage (plan §11 phase 5). Two citations, in the order a citation
is written:

  - THE PASSAGE the reader is at, with the passage's own anchor as the deep link.
    The anchor is the section (`#s4`), or the paragraph inside it where the
    document materialises one (`#s4-3`) — whichever the entry the reader is
    looking at carries, because that is the thing a link can land on.
  - THE PRINTED PAGE the passage stands on, with the page anchor (`#p15`) — the
    citation scholarship actually writes, and the one the page numbers were read
    from.

The edition's own line is built from the flags the page was handed (the
document's edition metadata, `citationFields` in tools/build.mjs) and never from
a string in this module: an app that hard-codes an imprint is an app that lies
about a different edition the first time the shelf gains one. -}
citePanel : Model -> Html Msg
citePanel m =
    if not m.cite then
        text ""

    else
        let
            ix =
                -- the passage the panel is ABOUT: the position when it was opened,
                -- not wherever the reader has scrolled since
                m.citeIx

            pg =
                -- the page the citation names: the page the reader NAVIGATED to
                -- when that is a printed page (jumping to #p15 is citing p.15),
                -- else the page the frozen passage starts on
                case m.atPage of
                    Just p ->
                        Just p

                    Nothing ->
                        pageAt m ix

            anchor =
                passageAnchor m ix

            head =
                citationHead m.citation

            tail =
                citationTail m.citation

            passageBlock =
                if String.isEmpty anchor then
                    text ""

                else
                    let
                        clause =
                            passageClause m ix anchor
                    in
                    div []
                        [ p [ class "rd-cite-line", attribute "data-cite" "passage" ]
                            [ text head
                            , em [] [ text m.citation.title ]
                            , text (tail ++ clause)
                            ]
                        , p []
                            [ a [ class "rd-cite-url", attribute "data-cite" "passage-url", href (m.base ++ "#" ++ anchor) ]
                                [ text (m.base ++ "#" ++ anchor) ]
                            ]
                        , p [ class "rd-dim" ]
                            [ text
                                ("That address is the passage's own anchor, and it is what the line above is read from"
                                    ++ (if String.isEmpty clause then
                                            " — this passage stands before the volume's first numbered division and before any printed page number, so the citation names the edition alone"

                                        else
                                            ""
                                       )
                                    ++ ". Inside a division the anchor is the division's (or, where the document materialises one, the paragraph's); at a note it is the note's."
                                )
                            ]
                        ]
        in
        aside [ id "rd-cite", class "rd-cite", attribute "tabindex" "-1", attribute "aria-label" "Cite this passage" ]
            [ div [ class "rd-cite-head" ]
                [ h3 [] [ text "Cite this passage" ]
                , button
                    [ type_ "button", class "rd-btn", Ev.onClick CiteToggle, attribute "aria-label" "Close the citation panel" ]
                    [ text "✕" ]
                ]
            , passageBlock
            , p [ class "rd-dim" ]
                [ text "The printed page this passage stands on — the number a citation by page needs:" ]
            , if pg == Nothing then
                p [] [ text "Turn to a printed page first — the citation names one, and this passage is in the front matter, which has no printed number." ]

              else
                let
                    n =
                        Maybe.withDefault 0 pg
                in
                div []
                    [ p [ class "rd-cite-line", attribute "data-cite" "line" ]
                        [ text head
                        , em [] [ text m.citation.title ]
                        , text (tail ++ ", p. " ++ String.fromInt n)
                        ]
                    , p []
                        [ a [ class "rd-cite-url", attribute "data-cite" "page-url", href (m.base ++ "#p" ++ String.fromInt n) ]
                            [ text (m.base ++ "#p" ++ String.fromInt n) ]
                        ]
                    , p [ class "rd-dim" ]
                        [ text ("That page number was read from the volume's own running heads, not from a count; the section here is " ++ String.fromInt (sectionNumberAt m ix) ++ ".")
                        ]
                    ]
            , div [ class "rd-print" ]
                [ h3 [] [ text "Print a range" ]
                , p [ class "rd-dim" ] [ text "Set the printed pages, then print the page. The reader's own furniture is left out, the page numbers print in the margin, the running heads are dropped and the notes print as endnotes at the back." ]
                , div [ class "rd-print-controls" ]
                    [ label [] [ text "from " ]
                    , input
                        [ type_ "text", class "rd-jump"
                        , value (m.range |> Maybe.map (Tuple.first >> String.fromInt) |> Maybe.withDefault "")
                        , Ev.onInput RangeFrom, Ev.onFocus (Typing True), Ev.onBlur (Typing False)
                        ]
                        []
                    , label [] [ text "to " ]
                    , input
                        [ type_ "text", class "rd-jump"
                        , value (m.range |> Maybe.map (Tuple.second >> String.fromInt) |> Maybe.withDefault "")
                        , Ev.onInput RangeTo, Ev.onFocus (Typing True), Ev.onBlur (Typing False)
                        ]
                        []
                    , button [ type_ "button", class "rd-btn", Ev.onClick RangeCurrent ] [ text "just this page" ]
                    , button [ type_ "button", class "rd-btn", Ev.onClick RangeClear ] [ text "the whole text" ]
                    ]
                ]
            ]


sectionNumberAt : Model -> Int -> Int
sectionNumberAt m ix =
    case sectionAt m ix of
        Just sid ->
            String.dropLeft 1 sid |> String.toInt |> Maybe.withDefault 0

        Nothing ->
            0


{-| The anchors of a citation line, in three parts so the title can stay an <em>
in the middle of them: the edition's own metadata is what the page handed over,
and these functions are the only place that spells the line. -}
citationHead : Citation -> String
citationHead c =
    c.author ++ ", "


citationTail : Citation -> String
citationTail c =
    ", trans. " ++ c.translator ++ " (" ++ c.place ++ ": " ++ c.publisher ++ ", " ++ c.year ++ ")"


{-| The division clause, when the reader is inside one: a section is the stable
citation unit of this book (what the reading itself cites by), and `0` means the
front matter, which the volume prints no division number for. -}
sectionClause : Model -> Int -> String
sectionClause m ix =
    if sectionNumberAt m ix > 0 then
        ", §" ++ String.fromInt (sectionNumberAt m ix)

    else
        ""


pageClause : Model -> Int -> String
pageClause m ix =
    case pageAt m ix of
        Just p ->
            ", p. " ++ String.fromInt p

        Nothing ->
            ""


{-| The number an anchor carries: "s4-3" is 4, "p15" is 15, "n5" is 5, and a
region anchor ("sfront", "snotes") carries none — which is why the clause below
can say "the front matter" rather than inventing a division number for it. -}
anchorNumber : String -> Int
anchorNumber anchor =
    anchor
        |> String.dropLeft 1
        |> String.split "-"
        |> List.head
        |> Maybe.withDefault ""
        |> String.toInt
        |> Maybe.withDefault 0


{-| What a passage's own anchor adds to the citation line. It is read off the
ANCHOR, not off the scroll position: a note's anchor is a note and not the
division the notes region happens to sit in, a page's is a page, and a division's
is the division — while the printed page, where the passage has one, is stated
beside it. -}
passageClause : Model -> Int -> String -> String
passageClause m ix anchor =
    case String.left 1 anchor of
        "s" ->
            if anchorNumber anchor > 0 then
                ", §" ++ String.fromInt (anchorNumber anchor) ++ pageClause m ix

            else
                pageClause m ix

        "p" ->
            sectionClause m ix ++ pageClause m ix

        "n" ->
            ", note " ++ String.fromInt (anchorNumber anchor)

        "r" ->
            ", note " ++ String.fromInt (anchorNumber anchor)

        _ ->
            ""


{-| The passage the reader is at, as an anchor: the nearest anchor at or before
the current entry. A running head, an unnumbered page marker and a refused one
carry no anchor of their own, and the passage they stand in is the one that does
— so the rule is "the last anchor at or before here", never "the last anchor
anywhere", which would cite a passage further down the page. -}
passageAnchor : Model -> Int -> String
passageAnchor m ix =
    m.entries
        |> List.take (max 0 (ix + 1))
        |> List.reverse
        |> List.filterMap (\e -> nonEmpty (entryAnchor e))
        |> List.head
        |> Maybe.withDefault ""


rulesPanel : Model -> Doc -> Html Msg
rulesPanel m doc =
    if not m.showRules then
        text ""

    else
        let
            rules =
                docRules m

            left =
                doc.leftWords
        in
        -- An OVERLAY, following the citation panel. It used to be rendered here,
        -- after the whole book, in the flow: a reader at the top of the volume
        -- clicked the control, the table was appended after 18 divisions and the
        -- footer, and nothing visible happened. As an overlay it is where the
        -- reader is (`.rd-diff` in READER_CSS), so it must not be put back in the
        -- flow — the app smoke asserts the fixed positioning.
        -- role=dialog with aria-modal="false" is what it is: a layer a reader
        -- opens, that takes focus and is closed by Escape, but that does NOT make
        -- the page behind it inert — the reader can still read and scroll there.
        aside
            [ id "rd-rules"
            , class "rd-diff"
            , attribute "role" "dialog"
            , attribute "aria-modal" "false"
            , attribute "tabindex" "-1"
            , attribute "aria-label" "The repairs, as rules"
            ]
            [ div [ class "rd-diff-head" ]
                [ h3 [] [ text "The repairs, as rules" ]
                , button
                    [ type_ "button", class "rd-btn", Ev.onClick RulesToggle, attribute "aria-label" "Close the list of repairs" ]
                    [ text "✕" ]
                ]
            , -- THE EDITION'S STATE, above the rules it is made of: a reader who
              -- opens this list to see what was changed should also be told what is
              -- NOT finished. Absent for an edition with no repair state.
              case m.repair of
                Just r ->
                    p [ class "rd-dim" ]
                        [ strong [] [ text ("This edition is " ++ r.label ++ ".") ]
                        , text (" " ++ r.note)
                        ]

                Nothing ->
                    text "" 
            , p [ class "rd-dim" ]
                [ text "The transcription is served exactly as it stands. The policy is: a recorded reading is substituted where one is recorded, and where none is the transcription's own characters stay — damage and all, marked in the reading view. These rules are the readings; nothing here is written into the text. The number beside each rule is how many times it fires in this text — counted when the document was built, in the order the rules are applied, so a rule cannot claim a repair it does not make." ]
            , if List.isEmpty rules then
                p [] [ text "No repairs are recorded for this text." ]

              else
                table []
                    [ thead []
                        [ tr []
                            [ th [] [ text "class" ]
                            , th [] [ text "the transcription" ]
                            , th [] [ text "the reading" ]
                            , th [] [ text "fires" ]
                            , th [] [ text "why" ]
                            ]
                        ]
                    , tbody []
                        (List.map
                            (\r ->
                                tr [ class (if r.find == r.repl then "rd-left" else "") ]
                                    [ td [] [ span [ class "rd-cls" ] [ text r.cls ] ]
                                    , td [] [ code [] [ text r.find ] ]
                                    , td []
                                        [ if r.find == r.repl then
                                            em [] [ text "no reading recorded — left" ]

                                          else
                                            code [] [ text r.repl ]
                                        ]
                                    , td [ class "rd-hits" ] [ text (String.fromInt r.hits) ]
                                    , td [ class "rd-why" ] [ text r.note ]
                                    ]
                            )
                            rules
                        )
                    ]
            , if List.isEmpty left then
                text ""

              else
                div [ class "rd-left-list" ]
                    [ p [ class "rd-left-h" ] [ strong [] [ text ("Damaged words left visible (" ++ String.fromInt (List.length left) ++ ")") ] ]
                    , p [ class "rd-dim" ]
                        [ text "No reading is recorded for these words, so the reading view shows the transcription's own characters and marks the damage. They are counted here rather than repaired by a guess." ]
                    , ul [] (List.map (\w -> li [] [ code [ class "rd-damage-word" ] [ text w ] ]) left)
                    ]
            ]


statusLine : Model -> Html Msg
statusLine m =
    div [ class "rd-live", attribute "aria-live" "polite", attribute "role" "status" ]
        [ text m.notice ]



{- ---------- main ---------- -}


main : Program Flags Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , view = view
        , subscriptions = subscriptions
        }
