module Reader.Store exposing (Bookmark, Stored, decode, encode, empty)

{-| What the reader keeps between visits, keyed by slug on the page's own
storage: where they were, what they marked, and how they like the text. Nothing
leaves the device — there is no server to send it to.

The codec is deliberately forgiving: a stored value written by an older build (or
by hand) must never stop the page from opening, so anything unreadable degrades to
the empty record.

-}

import Json.Decode as D
import Json.Encode as E


type alias Bookmark =
    { id : String, label : String, page : Maybe Int }


type alias Stored =
    { position : Maybe String
    , page : Maybe Int
    , section : Maybe String
    , bookmarks : List Bookmark
    , view : String
    , scale : Int
    }


empty : Stored
empty =
    { position = Nothing
    , page = Nothing
    , section = Nothing
    , bookmarks = []
    , view = "reading"
    , scale = 3
    }


decode : D.Value -> Stored
decode v =
    D.decodeValue decoder v |> Result.withDefault empty


decoder : D.Decoder Stored
decoder =
    D.map6 Stored
        (D.maybe (D.field "position" D.string))
        (D.maybe (D.field "page" D.int))
        (D.maybe (D.field "section" D.string))
        (D.oneOf [ D.field "bookmarks" (D.list bookmark), D.succeed [] ])
        (D.oneOf [ D.field "view" D.string, D.succeed "reading" ])
        (D.oneOf [ D.field "scale" D.int, D.succeed 3 ])


bookmark : D.Decoder Bookmark
bookmark =
    D.map3 Bookmark
        (D.field "id" D.string)
        (D.field "label" D.string)
        (D.maybe (D.field "page" D.int))


encode : Stored -> E.Value
encode s =
    E.object
        [ ( "position", maybe E.string s.position )
        , ( "page", maybe E.int s.page )
        , ( "section", maybe E.string s.section )
        , ( "bookmarks", E.list bookmarkEnc s.bookmarks )
        , ( "view", E.string s.view )
        , ( "scale", E.int s.scale )
        ]


bookmarkEnc : Bookmark -> E.Value
bookmarkEnc b =
    E.object
        [ ( "id", E.string b.id )
        , ( "label", E.string b.label )
        , ( "page", maybe E.int b.page )
        ]


maybe : (a -> E.Value) -> Maybe a -> E.Value
maybe f m =
    case m of
        Just x ->
            f x

        Nothing ->
            E.null
